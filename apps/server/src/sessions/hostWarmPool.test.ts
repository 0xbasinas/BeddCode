import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeAdapter } from '@beddcode/provider-core'
import type { CodexAdapter } from '@beddcode/provider-codex'
import { createClaudeAdapter } from '@beddcode/provider-claude'
import { createGrokAdapter } from '@beddcode/provider-grok'
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
      warmPool: { supported: true, prepareSession, fingerprint: () => 'test' },
    } as CodexAdapter
    expect(createHostWarmPool(undefined, [adapter], attachments.root)).toBeUndefined()
    expect(createHostWarmPool({ enabled: false }, [adapter], attachments.root)).toBeUndefined()
    expect(prepareSession).not.toHaveBeenCalled()
    const host = createHostWarmPool({ enabled: true }, [adapter], attachments.root)!
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
  it.each([
    ['claude', createClaudeAdapter],
    ['grok', createGrokAdapter],
  ] as const)('starts %s cold without warming it', async (kind, createAdapter) => {
    const cwd = os.tmpdir()
    const attachments = new AttachmentStore(path.join(cwd, 'host-warm-unsupported-test'))
    const fake = createFakeAdapter({ delayMs: 0 })
    const real = createAdapter()
    const startSession = vi.fn((_id, input) => fake.startSession('fake', input))
    const adapter = {
      ...real,
      detect: async () =>
        (await fake.detect()).map((instance) => ({ ...instance, kind, id: kind })),
      startSession,
    }
    const host = createHostWarmPool({ enabled: true }, [adapter], attachments.root)!
    host.warmProject(cwd)
    const take = vi.spyOn(host.pool, 'take')
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
      await manager.create({ instanceId: kind, cwd })
      expect(startSession).toHaveBeenCalledOnce()
      expect(take).toHaveBeenCalledOnce()
      await expect(take.mock.results[0]!.value).resolves.toBeNull()
    } finally {
      await manager.close()
      await host.pool.close()
      store.close()
    }
  })
})

describe('host warm pool invalidation', () => {
  it('disposes stale processes, starts cold at checkout, and rewarms', async () => {
    const cwd = os.tmpdir()
    const attachments = new AttachmentStore(path.join(cwd, 'host-warm-invalidation'))
    const fake = createFakeAdapter({ delayMs: 0 })
    let fingerprint = 'first'
    const close = vi.fn(async () => {})
    const activate = vi.fn(async (input) => fake.startSession('fake', input))
    const prepareSession = vi.fn(async () => ({
      healthy: async () => true,
      memoryBytes: async () => 1,
      close,
      activate,
    }))
    const startSession = vi.fn((_id, input) => fake.startSession('fake', input))
    const adapter = {
      ...fake,
      kind: 'codex',
      detect: async () =>
        (await fake.detect()).map((instance) => ({
          ...instance,
          kind: 'codex' as const,
          id: 'codex',
        })),
      startSession,
      prepareSession,
      warmPool: { supported: true, prepareSession, fingerprint: () => fingerprint },
    } as CodexAdapter
    const host = createHostWarmPool({ enabled: true }, [adapter], attachments.root)!
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
      host.warmProject(cwd)
      await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(1))
      fingerprint = 'second'
      await manager.create({ instanceId: 'codex', cwd })
      expect(close).toHaveBeenCalledTimes(1)
      expect(startSession).toHaveBeenCalledTimes(1)
      expect(activate).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(2))
    } finally {
      await manager.close()
      await host.pool.close()
      store.close()
    }
  })

  it('checks fingerprints periodically and rewarms without a checkout', async () => {
    vi.useFakeTimers()
    let fingerprint = 'first'
    const close = vi.fn(async () => {})
    const prepareSession = vi.fn(async () => ({
      healthy: async () => true,
      memoryBytes: async () => 1,
      close,
      activate: vi.fn(),
    }))
    const fake = createFakeAdapter({ delayMs: 0 })
    const adapter = {
      ...fake,
      kind: 'codex',
      warmPool: { supported: true, prepareSession, fingerprint: () => fingerprint },
    } as unknown as CodexAdapter
    const host = createHostWarmPool({ enabled: true }, [adapter], '/attachments')!
    try {
      host.warmProject('/project')
      await vi.advanceTimersByTimeAsync(0)
      expect(prepareSession).toHaveBeenCalledTimes(1)
      fingerprint = 'second'
      await vi.advanceTimersByTimeAsync(30_000)
      expect(close).toHaveBeenCalledTimes(1)
      expect(prepareSession).toHaveBeenCalledTimes(2)
    } finally {
      await host.pool.close()
      vi.useRealTimers()
    }
  })
})
