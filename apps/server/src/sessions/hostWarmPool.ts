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
  return {
    pool: {
      take: (key: string) => (find(key) ? pool.take(key) : Promise.resolve(null)),
      close: () => pool.close(),
    },
    warmProject: (cwd: string) => supported.forEach((entry) => pool.refill(keyFor(entry, cwd))),
    removeProject: (cwd: string) =>
      Promise.all(supported.map((entry) => pool.remove(keyFor(entry, cwd)))),
  }
}
