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
  it('prepares nothing unless enabled and supplies a warmed project to a session', async () => {
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
    for (const config of [undefined, { enabled: false }]) {
      const off = createHostWarmPool(config, [adapter], attachments.root)
      off.warmProject(cwd)
      await expect(off.pool.take('x')).resolves.toBeNull()
      await off.pool.close()
    }
    expect(prepareSession).not.toHaveBeenCalled()
    const host = createHostWarmPool({ enabled: true }, [adapter], attachments.root)
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
    const host = createHostWarmPool({ enabled: true }, [adapter], attachments.root)
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
    const host = createHostWarmPool({ enabled: true }, [adapter], attachments.root)
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

describe('host warm pool settings', () => {
  const setup = () => {
    const close = vi.fn(async () => {})
    const prepareSession = vi.fn(async () => ({
      healthy: async () => true,
      memoryBytes: async () => 1,
      close,
      activate: vi.fn(),
    }))
    const adapter = {
      ...createFakeAdapter({ delayMs: 0 }),
      kind: 'codex',
      warmPool: { supported: true, prepareSession, fingerprint: () => 'same' },
    } as unknown as CodexAdapter
    const persist = vi.fn()
    const host = createHostWarmPool(undefined, [adapter], '/attachments', persist)
    return { host, close, prepareSession, persist }
  }

  it('defaults to off and reports the defaults', async () => {
    const { host } = setup()
    expect(host.settings.get()).toEqual({
      enabled: false,
      size: 1,
      memoryCapMb: 1024,
      idleTimeoutMinutes: 10,
    })
    await host.pool.close()
  })

  it.each([
    [{ enabled: 'yes' }],
    [{ size: 5 }],
    [{ size: -1 }],
    [{ size: 1.5 }],
    [{ memoryCapMb: 0 }],
    [{ idleTimeoutMinutes: 0 }],
    [{ idleTimeoutMinutes: '10' }],
  ])('rejects %j without changing anything', async (change) => {
    const { host, persist } = setup()
    await expect(host.settings.set(change)).rejects.toThrow(/Invalid warm pool/)
    expect(host.settings.get().enabled).toBe(false)
    expect(persist).not.toHaveBeenCalled()
    await host.pool.close()
  })

  it('starts warming when switched on and stops when switched off', async () => {
    const { host, close, prepareSession, persist } = setup()
    try {
      host.warmProject('/project')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(prepareSession).not.toHaveBeenCalled()
      await expect(host.settings.set({ enabled: true })).resolves.toMatchObject({ enabled: true })
      await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(1))
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, size: 1 }))
      await host.settings.set({ enabled: false })
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
      await expect(
        host.pool.take(JSON.stringify(['codex', 'codex', '/project'])),
      ).resolves.toBeNull()
    } finally {
      await host.pool.close()
    }
  })

  it('resizes live, keeping unspecified values', async () => {
    const { host, close, prepareSession } = setup()
    try {
      await host.settings.set({ enabled: true, size: 2, idleTimeoutMinutes: 30 })
      host.warmProject('/project')
      await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(2))
      await host.settings.set({ size: 3 })
      expect(host.settings.get()).toEqual({
        enabled: true,
        size: 3,
        memoryCapMb: 1024,
        idleTimeoutMinutes: 30,
      })
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(5))
      await host.settings.set({ size: 0 })
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(5))
      expect(prepareSession).toHaveBeenCalledTimes(5)
    } finally {
      await host.pool.close()
    }
  })

  it('does not persist or restart for an unchanged value', async () => {
    const { host, persist } = setup()
    await host.settings.set({ enabled: false })
    expect(persist).not.toHaveBeenCalled()
    await host.pool.close()
  })
})
