import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeAdapter } from '@beddcode/provider-core'
import type { CodexAdapter } from '@beddcode/provider-codex'
import { createLogger } from '@beddcode/shared'
import { AttachmentStore } from '../attachments/store.ts'
import { EventStore } from '../store/eventStore.ts'
import { GitService } from '../workspace/git.ts'
import { createHostWarmPool } from './hostWarmPool.ts'
import { SessionManager } from './sessionManager.ts'

describe('host warm pool', () => {
  it('constructs only when enabled and supplies a warmed project to a session', async () => {
    const cwd = os.tmpdir()
    const attachments = new AttachmentStore(path.join(cwd, 'host-warm-test'))
    const fake = createFakeAdapter({ delayMs: 0 })
    const activate = vi.fn(async (input) => fake.startSession('fake', input))
    const healthy = vi.fn(async () => true)
    const prepareSession = vi.fn(async () => ({
      healthy,
      memoryBytes: async () => 1,
      close: async () => {},
      activate,
    }))
    const adapter = {
      ...fake,
      kind: 'codex',
      detect: async () =>
        (await fake.detect()).map((instance) => ({
          ...instance,
          kind: 'codex' as const,
          id: 'codex',
        })),
      prepareSession,
    } as CodexAdapter
    expect(createHostWarmPool(undefined, adapter, attachments.root)).toBeUndefined()
    expect(createHostWarmPool({ enabled: false }, adapter, attachments.root)).toBeUndefined()
    expect(prepareSession).not.toHaveBeenCalled()
    const host = createHostWarmPool({ enabled: true }, adapter, attachments.root)!
    host.warmProject(cwd)
    await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledWith(cwd))
    await vi.waitFor(() => expect(healthy).toHaveBeenCalled())
    const store = new EventStore(':memory:')
    const manager = new SessionManager({
      store,
      attachments,
      git: new GitService(),
      adapters: [adapter],
      log: createLogger('test', 'error'),
      defaultCwd: cwd,
      warmPool: host.pool,
    })
    try {
      await manager.create({ instanceId: 'codex', cwd })
      expect(activate).toHaveBeenCalledOnce()
    } finally {
      await manager.close()
      await host.pool.close()
      store.close()
    }
  })
})
