import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createFakeAdapter,
  type ProviderSession,
  type StartSessionInput,
} from '@beddcode/provider-core'
import { createLogger } from '@beddcode/shared'
import { AttachmentStore } from '../attachments/store.ts'
import { EventStore } from '../store/eventStore.ts'
import { GitService } from '../workspace/git.ts'
import { SessionManager, warmSessionKey, type WarmSession } from './sessionManager.ts'
import { WarmPool } from './warmPool.ts'

const cwd = os.tmpdir()
const attachments = new AttachmentStore(path.join(cwd, 'beddcode-warm-test'))
const options = { size: 1, idleTimeoutMs: 60_000, memoryCapBytes: 1_000, maintenanceIntervalMs: 0 }

describe('session start with a warm pool', () => {
  it('keys by provider, folder, model and config independent of config order', async () => {
    const instance = (await createFakeAdapter().detect())[0]!
    const input: StartSessionInput = {
      sessionId: 'x',
      cwd,
      model: 'fast',
      config: { a: true, b: 'x' },
    }
    const key = warmSessionKey(instance, input)
    expect(
      warmSessionKey(instance, { ...input, sessionId: 'y', config: { b: 'x', a: true } }),
    ).toBe(key)
    expect(warmSessionKey({ ...instance, id: 'other' }, input)).not.toBe(key)
    expect(warmSessionKey(instance, { ...input, cwd: path.join(cwd, 'other') })).not.toBe(key)
    expect(warmSessionKey(instance, { ...input, model: 'other' })).not.toBe(key)
    expect(warmSessionKey(instance, { ...input, config: { a: false, b: 'x' } })).not.toBe(key)
  })

  it('uses a matching fake process and refills after checkout', async () => {
    const starts: StartSessionInput[] = []
    const adapter = createFakeAdapter({ delayMs: 0, onStart: (input) => starts.push(input) })
    const instance = (await adapter.detect())[0]!
    const input: StartSessionInput = {
      sessionId: 'idle',
      cwd,
      model: 'fast',
      permissionMode: 'full',
      config: { choice: 'a' },
      additionalDirectories: [attachments.root],
    }
    let activated = 0
    const healthy = vi.fn(async () => true)
    const pool = new WarmPool<WarmSession>(options, async () => {
      const session = await adapter.startSession(instance.id, input)
      return {
        healthy,
        memoryBytes: async () => 1,
        close: () => session.close(),
        async activate(actual) {
          activated++
          // The fake process has no real binding protocol; translate its session identity for the host.
          const bound: ProviderSession = {
            ...session,
            sessionId: actual.sessionId,
            events: (async function* () {
              for await (const event of session.events)
                yield { ...event, sessionId: actual.sessionId }
            })(),
            prompt: session.prompt.bind(session),
            interrupt: session.interrupt.bind(session),
            setPermissionMode: session.setPermissionMode.bind(session),
            respondToApproval: session.respondToApproval.bind(session),
            close: session.close.bind(session),
          }
          return bound
        },
      }
    })
    const key = warmSessionKey(instance, input)
    pool.refill(key)
    await vi.waitFor(() => expect(healthy).toHaveBeenCalled())
    const store = new EventStore(':memory:')
    const manager = new SessionManager({
      store,
      attachments,
      git: new GitService(),
      adapters: [adapter],
      log: createLogger('test', 'error'),
      defaultCwd: cwd,
      warmPool: pool,
    })
    try {
      const created = await manager.create({
        instanceId: instance.id,
        cwd,
        model: 'fast',
        permissionMode: 'full',
        config: { choice: 'a' },
      })
      expect(activated).toBe(1)
      const warmStart = store
        .readSession(created.sessionId)
        .map(({ event }) => event)
        .find((event) => event.type === 'session.created')
      expect(warmStart).toMatchObject({ start: { warm: true } })
      await vi.waitFor(() => expect(starts).toHaveLength(2))
      await manager.prompt(created.sessionId, 'hello')
      await vi.waitFor(() =>
        expect(
          store.readSession(created.sessionId).some(({ event }) => event.type === 'turn.completed'),
        ).toBe(true),
      )
      expect(starts.every((start) => start.sessionId === 'idle')).toBe(true)
    } finally {
      await manager.close()
      await pool.close()
      store.close()
    }
  })

  it('starts cold on a key mismatch or a pool failure', async () => {
    const starts: StartSessionInput[] = []
    const adapter = createFakeAdapter({ onStart: (input) => starts.push(input) })
    const pool = new WarmPool<WarmSession>(options, async () => {
      throw new Error('unavailable')
    })
    const store = new EventStore(':memory:')
    const manager = new SessionManager({
      store,
      attachments,
      git: new GitService(),
      adapters: [adapter],
      log: createLogger('test', 'error'),
      defaultCwd: cwd,
      warmPool: pool,
    })
    try {
      pool.refill('different-provider-project-model-config')
      const first = await manager.create({ instanceId: 'fake', model: 'different' })
      expect(starts[0]?.sessionId).toBe(first.sessionId)
      const coldStart = store
        .readSession(first.sessionId)
        .map(({ event }) => event)
        .find((event) => event.type === 'session.created')
      expect(coldStart).toMatchObject({ start: { warm: false } })
      expect(coldStart?.type === 'session.created' && coldStart.start?.ms).toBeGreaterThanOrEqual(0)
      vi.spyOn(pool, 'take').mockRejectedValueOnce(new Error('pool failed'))
      const second = await manager.create({ instanceId: 'fake' })
      expect(starts[1]?.sessionId).toBe(second.sessionId)
    } finally {
      await manager.close()
      await pool.close()
      store.close()
    }
  })

  it('starts cold on timeout and disposes a resource returned late', async () => {
    const starts: StartSessionInput[] = []
    const adapter = createFakeAdapter({ onStart: (input) => starts.push(input) })
    let resolveTake!: (resource: WarmSession | null) => void
    const take = vi.fn(
      () =>
        new Promise<WarmSession | null>((resolve) => {
          resolveTake = resolve
        }),
    )
    const close = vi.fn(async () => {})
    const activate = vi.fn()
    const store = new EventStore(':memory:')
    const manager = new SessionManager({
      store,
      attachments,
      git: new GitService(),
      adapters: [adapter],
      log: createLogger('test', 'error'),
      defaultCwd: cwd,
      warmPool: { take },
      warmPoolTimeoutMs: 10,
    })
    try {
      const created = await manager.create({ instanceId: 'fake' })
      expect(starts[0]?.sessionId).toBe(created.sessionId)
      resolveTake({ healthy: async () => true, memoryBytes: async () => 1, close, activate })
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
      expect(activate).not.toHaveBeenCalled()
    } finally {
      await manager.close()
      store.close()
    }
  })
})
