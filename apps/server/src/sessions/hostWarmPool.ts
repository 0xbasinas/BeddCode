import { CODEX_INSTANCE_ID, type CodexAdapter } from '@beddcode/provider-codex'
import type { ProviderInstance } from '@beddcode/contracts'
import { WarmPool } from './warmPool.ts'
import { warmSessionKey, type WarmSession } from './sessionManager.ts'

/** Owns the host's idle Codex processes. Other providers always start cold. */
export function createHostWarmPool(
  config: { enabled: boolean } | undefined,
  codex: CodexAdapter,
  attachmentsRoot: string,
) {
  if (!config?.enabled) return undefined
  const pool = new WarmPool<WarmSession>(
    { size: 1, idleTimeoutMs: 10 * 60_000, memoryCapBytes: 1024 * 1024 * 1024 },
    async (key) => {
      const [kind, id, cwd] = JSON.parse(key) as unknown[]
      if (kind !== 'codex' || id !== CODEX_INSTANCE_ID || typeof cwd !== 'string')
        throw new Error('Unsupported warm session key')
      return codex.prepareSession(cwd)
    },
  )
  const keyFor = (cwd: string) =>
    warmSessionKey({ kind: 'codex', id: CODEX_INSTANCE_ID } as ProviderInstance, {
      sessionId: '',
      cwd,
      additionalDirectories: [attachmentsRoot],
    })
  return {
    pool,
    warmProject: (cwd: string) => pool.refill(keyFor(cwd)),
    removeProject: (cwd: string) => pool.remove(keyFor(cwd)),
  }
}
