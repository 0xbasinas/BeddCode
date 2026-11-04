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
import { deliverPeer, recoverPeerDeliveries } from '../automation/peerDelivery.ts'

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
  const interrupted: string[] = []
  const prompts: { text: string }[] = []
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
        async prompt(prompt) {
          prompts.push(prompt)
          queue.push({
            type: 'turn.started',
            sessionId: input.sessionId,
            at: at(),
            turnId: `turn-${prompts.length}`,
          })
          queue.push({
            type: 'turn.completed',
            sessionId: input.sessionId,
            at: at(),
            reason: 'done',
          })
        },
        interrupt: async () => {
          interrupted.push(input.sessionId)
        },
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
  return { adapter, starts, closed, interrupted, prompts }
}

function setup(
  opts: Parameters<typeof resumableAdapter>[0],
  projectInstructions?: (folder: string) => string,
) {
  const store = new EventStore(':memory:')
  const stub = resumableAdapter(opts)
  const manager = new SessionManager({
    attachments,
    projectInstructions,
    git: new GitService(),
    store,
    adapters: [stub.adapter],
    log: createLogger('test', 'error'),
    defaultCwd: os.tmpdir(),
    agentToolServers: () => [],
  })
  return { store, manager, ...stub }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('SessionManager', () => {
  it('recovers a peer prompt removed from memory before it reaches the provider', async () => {
    const { store, manager, prompts, adapter } = setup({ resume: true })
    const { sessionId } = await manager.create({ instanceId: 'stub', projectless: true })
    const message = {
      messageId: 'crash-delivery',
      threadId: 'thread',
      senderId: 'sender',
      recipientId: sessionId,
      text: 'hello',
      prompt: 'peer hello',
      at: Date.now(),
    }
    // Freeze the first host after the in-memory queue is shifted and before prompt().
    let crash!: (error: Error) => void
    vi.spyOn(manager as never, 'checkpointBefore').mockImplementation(
      () =>
        new Promise((_, reject) => {
          crash = reject
        }),
    )
    store.enqueuePeerDelivery(message)
    deliverPeer(store, message, (m) => {
      void manager.wakePeerMessage(m.recipientId, m.messageId, m.prompt)
    })
    await vi.waitFor(() =>
      expect(
        (manager as unknown as { turns: Map<string, { queueStarting?: string }> }).turns.get(
          sessionId,
        )?.queueStarting,
      ).toBe(message.messageId),
    )
    expect(prompts).toHaveLength(0)
    expect(store.peerDeliveries(true)).toEqual([message])
    expect(
      store.readSession(sessionId).filter(({ event }) => event.type === 'prompt.dequeued'),
    ).toHaveLength(0)

    const restarted = new SessionManager({
      store,
      attachments,
      git: new GitService(),
      adapters: [adapter],
      log: createLogger('test', 'error'),
      defaultCwd: os.tmpdir(),
      agentToolServers: () => [],
    })
    const wake = (m: typeof message) => {
      void restarted.wakePeerMessage(m.recipientId, m.messageId, m.prompt)
    }
    recoverPeerDeliveries(store, wake, (error) => {
      throw error
    })
    recoverPeerDeliveries(store, wake, (error) => {
      throw error
    })
    await vi.waitFor(() => expect(store.peerDeliveries(true)).toEqual([]))
    recoverPeerDeliveries(store, wake, (error) => {
      throw error
    })
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    expect(prompts[0]?.text).toBe('peer hello')
    expect(
      store.readSession(sessionId).filter(({ event }) => event.type === 'prompt.queued'),
    ).toHaveLength(1)
    expect(
      store.readSession(sessionId).filter(({ event }) => event.type === 'prompt.dequeued'),
    ).toHaveLength(1)
    await restarted.close()
    crash(new Error('simulated host crash'))
    await manager.close()
  })
  it('captures project instructions for agent prompts without changing the user message', async () => {
    let rules = 'Run the tests'
    const { store, manager, prompts } = setup({ resume: true }, () => rules)
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    rules = 'Changed later'
    await manager.prompt(sessionId, 'Implement this')
    await vi.waitFor(() => expect(prompts[0]).toBeDefined())
    expect(prompts[0]?.text).toContain('Run the tests')
    expect(prompts[0]?.text).not.toContain('Changed later')
    expect(
      store
        .readSession(sessionId)
        .map(({ event }) => event)
        .find((event) => event.type === 'message.delta'),
    ).toMatchObject({ text: 'Implement this' })
    await manager.close()
  })

  it('directs design pane prompts to the canvas without changing the recorded message', async () => {
    const { store, manager, prompts } = setup({ resume: true })
    const design = await manager.create({ instanceId: 'stub', designTools: true })
    await manager.prompt(design.sessionId, 'Make a dashboard')
    await vi.waitFor(() => expect(prompts[0]).toBeDefined())
    expect(prompts[0]?.text).toContain('editable canvas using the BeddCode design MCP tools')
    expect(prompts[0]?.text).toContain('Make a dashboard')
    expect(
      store
        .readSession(design.sessionId)
        .map(({ event }) => event)
        .find((event) => event.type === 'message.delta'),
    ).toMatchObject({ text: 'Make a dashboard' })
    const normal = await manager.create({ instanceId: 'stub' })
    await manager.prompt(normal.sessionId, 'Make a dashboard')
    await vi.waitFor(() => expect(prompts[1]).toBeDefined())
    expect(prompts[1]?.text).toBe('Make a dashboard')
    await manager.close()
  })
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
  it('stops an agent’s helpers with it only when asked, and always when it is deleted', async () => {
    const { manager, interrupted } = setup({ resume: true })
    const parent = await manager.create({ instanceId: 'stub' })
    const child = await manager.create(
      { instanceId: 'stub' },
      { parent: { sessionId: parent.sessionId, depth: 1 } },
    )
    const grandchild = await manager.create(
      { instanceId: 'stub' },
      { parent: { sessionId: child.sessionId, depth: 2 } },
    )
    const other = await manager.create({ instanceId: 'stub' })

    // Stopping a turn to change direction leaves the helpers working.
    await manager.interrupt(parent.sessionId)
    expect(interrupted).toEqual([parent.sessionId])

    interrupted.length = 0
    await manager.interrupt(parent.sessionId, { includeChildren: true })
    expect(interrupted.sort()).toEqual(
      [parent.sessionId, child.sessionId, grandchild.sessionId].sort(),
    )

    interrupted.length = 0
    await manager.interrupt(child.sessionId, { includeChildren: true })
    expect(interrupted.sort()).toEqual([child.sessionId, grandchild.sessionId].sort())
    expect(interrupted).not.toContain(other.sessionId)

    interrupted.length = 0
    await manager.delete(parent.sessionId)
    expect(interrupted.sort()).toEqual([child.sessionId, grandchild.sessionId].sort())
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
