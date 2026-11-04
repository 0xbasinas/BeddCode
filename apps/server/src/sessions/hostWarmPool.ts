import { CODEX_INSTANCE_ID } from '@beddcode/provider-codex'
import { CLAUDE_INSTANCE_ID } from '@beddcode/provider-claude'
import { GROK_INSTANCE_ID } from '@beddcode/provider-grok'
import type { ProviderInstance } from '@beddcode/contracts'
import type { ProviderAdapter } from '@beddcode/provider-core'
import { WarmPool } from './warmPool.ts'
import { warmSessionKey, type WarmSession } from './sessionManager.ts'

/** Owns the host's idle processes for providers that support preparation. */
export function createHostWarmPool(
  config: { enabled: boolean } | undefined,
  adapters: ProviderAdapter[],
  attachmentsRoot: string,
) {
  if (!config?.enabled) return undefined
  const ids = { codex: CODEX_INSTANCE_ID, claude: CLAUDE_INSTANCE_ID, grok: GROK_INSTANCE_ID }
  const supported = adapters.flatMap((adapter) => {
    const id = ids[adapter.kind as keyof typeof ids]
    return id && adapter.warmPool?.supported
      ? [{ kind: adapter.kind, id, warm: adapter.warmPool }]
      : []
  })
  const find = (key: string) => {
    try {
      const [kind, id, cwd] = JSON.parse(key) as unknown[]
      const entry = supported.find((candidate) => candidate.kind === kind && candidate.id === id)
      return entry && typeof cwd === 'string' ? { entry, cwd } : undefined
    } catch {
      return undefined
    }
  }
  const pool = new WarmPool<WarmSession>(
    { size: 1, idleTimeoutMs: 10 * 60_000, memoryCapBytes: 1024 * 1024 * 1024 },
    async (key) => {
      const match = find(key)
      if (!match) throw new Error('Unsupported warm session key')
      return match.entry.warm.prepareSession(match.cwd)
    },
  )
  const keyFor = (entry: (typeof supported)[number], cwd: string) =>
    warmSessionKey({ kind: entry.kind, id: entry.id } as ProviderInstance, {
      sessionId: '',
      cwd,
      additionalDirectories: [attachmentsRoot],
    })
  const keys = new Map<string, (typeof supported)[number]>()
  const fingerprints = new Map<(typeof supported)[number], string>()
  let closed = false
  let serial: Promise<void> = Promise.resolve()
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = serial.then(fn)
    serial = result.then(
      () => {},
      () => {},
    )
    return result
  }
  // Return false on a change or a read failure: a checkout must then start cold.
  const check = async (entry: (typeof supported)[number]): Promise<boolean> => {
    let fingerprint: string | undefined
    try {
      fingerprint = entry.warm.fingerprint()
    } catch {
      // Do not hand out a process when its inputs cannot be verified.
    }
    const previous = fingerprints.get(entry)
    if (fingerprint !== undefined && previous === fingerprint) return true
    if (fingerprint === undefined) fingerprints.delete(entry)
    else fingerprints.set(entry, fingerprint)
    const affected = [...keys].filter(([, candidate]) => candidate === entry).map(([key]) => key)
    await Promise.all(affected.map((key) => pool.remove(key)))
    if (!closed && fingerprint !== undefined) affected.forEach((key) => pool.refill(key))
    return false
  }
  const timer = setInterval(() => {
    void locked(async () => {
      if (closed) return
      for (const entry of supported) {
        if ([...keys.values()].includes(entry)) await check(entry)
      }
    })
  }, 30_000)
  timer.unref?.()
  return {
    pool: {
      take: (key: string) =>
        locked(async () => {
          const match = find(key)
          if (closed || !match || !keys.has(key) || !(await check(match.entry))) return null
          const resource = await pool.take(key)
          if (resource && !(await check(match.entry))) {
            await resource.close().catch(() => {})
            return null
          }
          return resource
        }),
      close: async () => {
        closed = true
        clearInterval(timer)
        await locked(async () => pool.close())
      },
    },
    warmProject: (cwd: string) => {
      void locked(async () => {
        if (closed) return
        for (const entry of supported) {
          const key = keyFor(entry, cwd)
          keys.set(key, entry)
          if (await check(entry)) pool.refill(key)
        }
      })
    },
    removeProject: (cwd: string) =>
      locked(async () => {
        await Promise.all(
          supported.map((entry) => {
            const key = keyFor(entry, cwd)
            keys.delete(key)
            return pool.remove(key)
          }),
        )
      }),
  }
}
