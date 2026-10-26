import { describe, expect, it, vi } from 'vitest'
import type { ProviderCapabilities, ProviderInstance, SessionEvent } from '@beddcode/contracts'
import type { ProviderAdapter, ProviderSession, StartSessionInput } from '@beddcode/provider-core'
import { createAsyncQueue, createLogger } from '@beddcode/shared'
import os from 'node:os'
import path from 'node:path'
import { AttachmentStore } from '../attachments/store.ts'
import { EventStore } from '../store/eventStore.ts'
import { GitService } from '../workspace/git.ts'
import { SessionManager } from './sessionManager.ts'

const attachments = new AttachmentStore(path.join(os.tmpdir(), 'beddcode-manager-test'))

const caps = (resume: boolean): ProviderCapabilities => ({
  resume,
  fork: false,
  steer: false,
  planMode: false,
  imageInput: false,
  usage: false,
  permissionModes: [],
})

/** A provider that announces a native session id and completes each prompt immediately. */
function resumableAdapter(opts: { resume: boolean; status?: ProviderInstance['status'] }) {
  const starts: StartSessionInput[] = []
  const closed: string[] = []
  const instance: ProviderInstance = {
    id: 'stub',
    kind: 'acp',
    label: 'Stub',
    status: opts.status ?? 'ready',
    capabilities: caps(opts.resume),
  }
  const adapter: ProviderAdapter = {
    kind: 'acp',
    detect: async () => [instance],
    capabilities: () => caps(opts.resume),
    async startSession(_id, input) {
      starts.push(input)
      const queue = createAsyncQueue<SessionEvent>()
      const at = () => Date.now()
      queue.push({
        type: 'session.provider-session',
        sessionId: input.sessionId,
        at: at(),
        providerSessionId: `native-${starts.length}`,
      })
      const session: ProviderSession = {
        sessionId: input.sessionId,
        events: queue,
        async prompt() {
          queue.push({
            type: 'turn.completed',
            sessionId: input.sessionId,
            at: at(),
            reason: 'done',
          })
        },
        interrupt: async () => {},
        setPermissionMode: async () => {},
        respondToApproval: async () => {},
        async close() {
          closed.push(input.sessionId)
          queue.close()
        },
      }
      return session
    },
  }
  return { adapter, starts, closed }
}

function setup(opts: Parameters<typeof resumableAdapter>[0]) {
  const store = new EventStore(':memory:')
  const stub = resumableAdapter(opts)
  const manager = new SessionManager({
    attachments,
    git: new GitService(),
    store,
    adapters: [stub.adapter],
    log: createLogger('test', 'error'),
    defaultCwd: os.tmpdir(),
  })
  return { store, manager, ...stub }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('SessionManager', () => {
  it('persists a renamed title without needing a running provider and rejects unknown sessions', async () => {
    const { store, manager } = setup({ resume: true })
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.close()
    manager.rename(sessionId, 'Investigate retries')
    expect(store.readSession(sessionId).at(-1)?.event).toMatchObject({
      type: 'session.renamed',
      title: 'Investigate retries',
    })
    expect(() => manager.rename('missing', 'No session')).toThrow('Unknown session')
  })
  it('files a session as done and back, and rejects unknown sessions', async () => {
    const { store, manager } = setup({ resume: true })
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.close()
    manager.setDone(sessionId, true)
    expect(store.readSession(sessionId).at(-1)?.event).toMatchObject({
      type: 'session.done',
      done: true,
    })
    manager.setDone(sessionId, false)
    expect(store.readSession(sessionId).at(-1)?.event).toMatchObject({
      type: 'session.done',
      done: false,
    })
    expect(() => manager.setDone('missing', true)).toThrow('Unknown session')
  })
  it('deletes a session: its events leave the log and only the deletion remains', async () => {
    const { store, manager } = setup({ resume: true })
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    const other = await manager.create({ instanceId: 'stub' })
    await manager.delete(sessionId)
    expect(store.readSession(sessionId).map((e) => e.event.type)).toEqual(['session.deleted'])
    expect(store.readSession(other.sessionId).length).toBeGreaterThan(0)
    await expect(manager.delete(sessionId)).rejects.toThrow('Unknown session')
  })
  it('refuses to start a session on a provider that is not ready', async () => {
    const { manager } = setup({ resume: true, status: 'needs-sign-in' })
    await expect(manager.create({ instanceId: 'stub' })).rejects.toThrow('not ready')
  })

  it('resumes a session after its process is gone, using the stored provider session id', async () => {
    const { store, manager, starts } = setup({ resume: true })
    const { sessionId } = await manager.create({ instanceId: 'stub', permissionMode: 'plan' })
    await tick()

    // Simulate a server restart: a fresh manager over the same log has no live sessions.
    const restarted = new SessionManager({
      attachments,
      git: new GitService(),
      store,
      adapters: [setupAdapterFrom(starts)],
      log: createLogger('test', 'error'),
      defaultCwd: '/x',
    })
    await restarted.prompt(sessionId, 'continue')
    await vi.waitFor(() =>
      expect(store.readSession(sessionId).map((e) => e.event.type)).toContain('turn.completed'),
    )

    expect(starts).toHaveLength(2)
    expect(starts[1]).toMatchObject({
      sessionId,
      cwd: os.tmpdir(),
      permissionMode: 'plan',
      resumeId: 'native-1',
    })
  })

  it('starts only one provider process for concurrent prompts to a stopped session', async () => {
    const { store, manager, starts } = setup({ resume: true })
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await tick()
    const restarted = new SessionManager({
      attachments,
      git: new GitService(),
      store,
      adapters: [setupAdapterFrom(starts)],
      log: createLogger('test', 'error'),
      defaultCwd: '/x',
    })
    await Promise.all([restarted.prompt(sessionId, 'a'), restarted.prompt(sessionId, 'b')])
    expect(starts).toHaveLength(2)
  })

  it('reports a clear error when the provider cannot resume', async () => {
    const { store, manager, starts } = setup({ resume: false })
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await tick()
    const restarted = new SessionManager({
      attachments,
      git: new GitService(),
      store,
      adapters: [setupAdapterFrom(starts, false)],
      log: createLogger('test', 'error'),
      defaultCwd: '/x',
    })
    await expect(restarted.prompt(sessionId, 'hi')).rejects.toThrow('cannot resume')
  })
})

/** Rebuilds an equivalent adapter that appends to the same `starts` list. */
function setupAdapterFrom(starts: StartSessionInput[], resume = true): ProviderAdapter {
  const rebuilt = resumableAdapter({ resume })
  const original = rebuilt.adapter.startSession
  rebuilt.adapter.startSession = async (id, input) => {
    starts.push(input)
    return original(id, input)
  }
  // `original` also pushes into its own list; only the shared `starts` list is asserted.
  return rebuilt.adapter
}
