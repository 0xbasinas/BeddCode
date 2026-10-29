import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderCapabilities, ProviderInstance, SessionEvent } from '@beddcode/contracts'
import type { ProviderAdapter, ProviderSession, StartSessionInput } from '@beddcode/provider-core'
import { createAsyncQueue, createLogger } from '@beddcode/shared'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AttachmentStore } from '../attachments/store.ts'
import { EventStore } from '../store/eventStore.ts'
import { GitService } from '../workspace/git.ts'
import { SessionManager } from './sessionManager.ts'

const attachments = new AttachmentStore(path.join(os.tmpdir(), 'beddcode-robustness-test'))

const caps: ProviderCapabilities = {
  resume: true,
  fork: false,
  steer: false,
  planMode: false,
  imageInput: false,
  usage: false,
  permissionModes: [],
}

type Draft = { type: string; [key: string]: unknown }

/**
 * An agent the test drives by hand: `emit` sends its events, `crash` ends its process with the
 * turn still open, and `onPrompt` decides what a message does.
 */
function scriptedAdapter() {
  const starts: StartSessionInput[] = []
  let current: ReturnType<typeof createAsyncQueue<SessionEvent>> | undefined
  let sessionId = ''
  const interrupted: number[] = []
  let failWith: Error | undefined
  // The stream of a process that died: it ends, with the transport's error if there was one.
  async function* stream(queue: AsyncIterable<SessionEvent>) {
    for await (const event of queue) yield event
    if (failWith) throw failWith
  }
  const state = {
    onPrompt: (_emit: (e: Draft) => void) => {},
    onInterrupt: (_emit: (e: Draft) => void) => {},
    failResume: undefined as string | undefined,
  }
  const emit = (e: Draft) =>
    current?.push({ sessionId, at: Date.now(), ...e } as unknown as SessionEvent)
  const instance: ProviderInstance = {
    id: 'stub',
    kind: 'acp',
    label: 'Stub',
    status: 'ready',
    capabilities: caps,
  }
  const adapter: ProviderAdapter = {
    kind: 'acp',
    detect: async () => [instance],
    capabilities: () => caps,
    async startSession(_id, input) {
      starts.push(input)
      if (input.resumeId && state.failResume) throw new Error(state.failResume)
      const queue = createAsyncQueue<SessionEvent>()
      current = queue
      failWith = undefined
      sessionId = input.sessionId
      emit({ type: 'session.provider-session', providerSessionId: `native-${starts.length}` })
      return {
        sessionId: input.sessionId,
        events: stream(queue),
        prompt: async () => state.onPrompt(emit),
        interrupt: async () => {
          interrupted.push(Date.now())
          state.onInterrupt(emit)
        },
        setPermissionMode: async () => {},
        respondToApproval: async () => {},
        close: async () => queue.close(),
      } satisfies ProviderSession
    },
  }
  return {
    adapter,
    starts,
    interrupted,
    state,
    emit,
    crash: (error?: Error) => {
      failWith = error
      current?.close()
    },
  }
}

function setup(stallMs = 0) {
  const store = new EventStore(':memory:')
  const stub = scriptedAdapter()
  const manager = new SessionManager({
    attachments,
    git: new GitService(),
    store,
    adapters: [stub.adapter],
    log: createLogger('test', 'error'),
    defaultCwd: os.tmpdir(),
    stallMs,
  })
  const events = (sessionId: string) => store.readSession(sessionId).map((s) => s.event)
  return { store, manager, events, ...stub }
}

const until = async (check: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const folders: string[] = []
afterEach(() => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true })
})

describe('SessionManager robustness', () => {
  it('ends the open turn with a reason when the agent process dies mid-reply, and resumes on the next message', async () => {
    const { manager, events, state, crash, starts } = setup()
    state.onPrompt = (emit) => {
      emit({ type: 'turn.started', turnId: 't1' })
      emit({ type: 'message.delta', turnId: 't1', role: 'assistant', text: 'Half a rep' })
    }
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.prompt(sessionId, 'hi')
    await until(() =>
      events(sessionId).some((e) => e.type === 'message.delta' && e.role === 'assistant'),
    )

    crash(new Error('read EPIPE'))
    await until(() => events(sessionId).some((e) => e.type === 'turn.completed'))
    const tail = events(sessionId).slice(-2)
    expect(tail[0]).toMatchObject({
      type: 'error',
      turnId: 't1',
      message: expect.stringMatching(/stopped unexpectedly: read EPIPE/),
    })
    expect(tail[1]).toMatchObject({ type: 'turn.completed', turnId: 't1', reason: 'error' })

    // Not stuck: the next message starts the agent again on the same conversation.
    state.onPrompt = (emit) => emit({ type: 'turn.completed', reason: 'done' })
    await manager.prompt(sessionId, 'again')
    await until(() => events(sessionId).filter((e) => e.type === 'turn.completed').length === 2)
    expect(starts.at(-1)?.resumeId).toBe('native-1')
    await manager.close()
  })

  it('records nothing extra when the process ends between turns, or on purpose', async () => {
    const { manager, events, state, crash } = setup()
    state.onPrompt = (emit) => {
      emit({ type: 'turn.started', turnId: 't1' })
      emit({ type: 'turn.completed', turnId: 't1', reason: 'done' })
    }
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.prompt(sessionId, 'hi')
    await until(() => events(sessionId).some((e) => e.type === 'turn.completed'))
    const before = events(sessionId).length
    crash()
    await new Promise((r) => setTimeout(r, 30))
    expect(events(sessionId)).toHaveLength(before)
    await manager.close()
  })

  it('says why a turn was cancelled when nobody pressed stop, and stays quiet when someone did', async () => {
    const { manager, events, state } = setup()
    state.onPrompt = (emit) => {
      emit({ type: 'turn.started', turnId: 't1' })
      emit({ type: 'turn.completed', turnId: 't1', reason: 'cancelled' })
    }
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.prompt(sessionId, 'hi')
    await until(() => events(sessionId).some((e) => e.type === 'turn.completed'))
    expect(events(sessionId).at(-1)).toMatchObject({
      reason: 'cancelled',
      message: expect.stringMatching(/on its own/),
    })

    state.onPrompt = (emit) => emit({ type: 'turn.started', turnId: 't2' })
    state.onInterrupt = (emit) =>
      emit({ type: 'turn.completed', turnId: 't2', reason: 'cancelled' })
    await manager.prompt(sessionId, 'again')
    await until(() => events(sessionId).some((e) => e.turnId === 't2'))
    await manager.interrupt(sessionId)
    await until(() =>
      events(sessionId).some((e) => e.type === 'turn.completed' && e.turnId === 't2'),
    )
    const stopped = events(sessionId).at(-1)
    expect(stopped).toMatchObject({ type: 'turn.completed', reason: 'cancelled' })
    expect(stopped).not.toHaveProperty('message')
    await manager.close()
  })

  it('does not blame the agent for a turn it ended after the user said no', async () => {
    const { manager, events, state, emit } = setup()
    state.onPrompt = (e) => {
      e({ type: 'turn.started', turnId: 't1' })
      e({
        type: 'approval.requested',
        turnId: 't1',
        requestId: 'r1',
        title: 'Run rm',
        options: [
          { id: 'ok', label: 'Allow', kind: 'allow' },
          { id: 'no', label: 'Deny', kind: 'deny' },
        ],
      })
    }
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.prompt(sessionId, 'hi')
    await until(() => events(sessionId).some((e) => e.type === 'approval.requested'))
    emit({ type: 'approval.resolved', turnId: 't1', requestId: 'r1', optionId: 'no' })
    emit({ type: 'turn.completed', turnId: 't1', reason: 'cancelled' })
    await until(() => events(sessionId).some((e) => e.type === 'turn.completed'))
    expect(events(sessionId).at(-1)).not.toHaveProperty('message')
    await manager.close()
  })

  it('stops a turn whose agent went silent, but not one running a long tool', async () => {
    const { manager, events, state, interrupted, emit } = setup(60)
    state.onPrompt = (e) => {
      e({ type: 'turn.started', turnId: 't1' })
      e({ type: 'tool.started', turnId: 't1', toolId: 'build', title: 'Bash', kind: 'command' })
    }
    state.onInterrupt = (e) => e({ type: 'turn.completed', turnId: 't1', reason: 'cancelled' })
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.prompt(sessionId, 'hi')
    await new Promise((r) => setTimeout(r, 200))
    expect(interrupted).toHaveLength(0)

    emit({ type: 'tool.completed', turnId: 't1', toolId: 'build', ok: true })
    await until(() => events(sessionId).some((e) => e.type === 'turn.completed'))
    expect(interrupted).toHaveLength(1)
    const error = events(sessionId).find((e) => e.type === 'error')
    expect(error).toMatchObject({ message: expect.stringMatching(/sent nothing for \d+ seconds/) })
    // The error already says why; the cancel is not re-explained as the agent's own doing.
    expect(events(sessionId).at(-1)).not.toHaveProperty('message')
    await manager.close()
  })

  it('explains a resume whose folder is gone instead of failing with ENOENT', async () => {
    const { manager, crash } = setup()
    const folder = mkdtempSync(path.join(os.tmpdir(), 'beddcode-gone-'))
    const { sessionId } = await manager.create({ instanceId: 'stub', cwd: folder })
    crash()
    await new Promise((r) => setTimeout(r, 20))
    rmSync(folder, { recursive: true })
    await expect(manager.prompt(sessionId, 'hi')).rejects.toThrow(/folder no longer exists/)
    await manager.close()
  })

  it('continues in a new conversation when the agent lost the old one, and says so', async () => {
    const { manager, events, state, crash, starts } = setup()
    const folder = mkdtempSync(path.join(os.tmpdir(), 'beddcode-lost-'))
    folders.push(folder)
    const { sessionId } = await manager.create({ instanceId: 'stub', cwd: folder })
    crash()
    await new Promise((r) => setTimeout(r, 20))
    state.failResume = 'no rollout found for thread id native-1'
    state.onPrompt = (emit) => emit({ type: 'turn.completed', reason: 'done' })
    await manager.prompt(sessionId, 'hi')
    await until(() => events(sessionId).some((e) => e.type === 'turn.completed'))
    expect(starts.at(-1)?.resumeId).toBeUndefined()
    expect(events(sessionId).find((e) => e.type === 'error')).toMatchObject({
      message: expect.stringMatching(/no longer has this conversation/),
    })
    await manager.close()
  })
})
