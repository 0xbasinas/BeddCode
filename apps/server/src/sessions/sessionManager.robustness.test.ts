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
  const steered: string[] = []
  const prompts: string[] = []
  let failWith: Error | undefined
  // The stream of a process that died: it ends, with the transport's error if there was one.
  async function* stream(queue: AsyncIterable<SessionEvent>) {
    for await (const event of queue) yield event
    if (failWith) throw failWith
  }
  const state = {
    onPrompt: (_emit: (e: Draft) => void): void | Promise<void> => {},
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
        prompt: async (input) => {
          prompts.push(input.text)
          await state.onPrompt(emit)
        },
        steer: async (input) => {
          steered.push(input.text)
        },
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
    instance,
    starts,
    steered,
    prompts,
    interrupted,
    state,
    emit,
    crash: (error?: Error) => {
      failWith = error
      current?.close()
    },
  }
}

function setup(stallMs = 0, toolStallMs?: number) {
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
    toolStallMs,
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
    // Long enough that a slow machine records the tool start well inside it (Windows CI did not).
    const { manager, events, state, interrupted, emit } = setup(250)
    state.onPrompt = (e) => {
      e({ type: 'turn.started', turnId: 't1' })
      e({ type: 'tool.started', turnId: 't1', toolId: 'build', title: 'Bash', kind: 'command' })
    }
    state.onInterrupt = (e) => e({ type: 'turn.completed', turnId: 't1', reason: 'cancelled' })
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.prompt(sessionId, 'hi')
    await new Promise((r) => setTimeout(r, 700))
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

  it('continues in a new conversation when the agent finds out only at the first message, sending it again', async () => {
    const { manager, events, state, crash, starts, prompts } = setup()
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    crash()
    await new Promise((r) => setTimeout(r, 20))
    // Like Claude: the resume itself succeeds, the first message fails.
    state.onPrompt = (emit) => {
      if (starts.at(-1)?.resumeId) {
        emit({ type: 'turn.started', turnId: 'turn-1' })
        emit({
          type: 'error',
          turnId: 'turn-1',
          message: 'No conversation found with session ID: native-1',
        })
        emit({ type: 'turn.completed', turnId: 'turn-1', reason: 'error' })
      } else {
        emit({ type: 'turn.started', turnId: 'turn-1' })
        emit({ type: 'message.delta', turnId: 'turn-1', role: 'assistant', text: 'fresh' })
        emit({ type: 'turn.completed', turnId: 'turn-1', reason: 'done' })
      }
    }
    await manager.prompt(sessionId, 'hi')
    await until(() => events(sessionId).some((e) => e.type === 'turn.completed'))
    expect(starts.at(-1)?.resumeId).toBeUndefined()
    expect(prompts).toEqual(['hi', 'hi'])
    const log = events(sessionId)
    // One message, one turn, one explanation, and the answer.
    expect(log.filter((e) => e.type === 'message.delta' && e.role === 'user')).toHaveLength(1)
    expect(log.filter((e) => e.type === 'turn.started')).toHaveLength(1)
    expect(log.filter((e) => e.type === 'turn.completed')).toEqual([
      expect.objectContaining({ reason: 'done' }),
    ])
    const errors = log.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      message: expect.stringMatching(/no longer has this conversation/),
    })
    expect(log.some((e) => e.type === 'message.delta' && e.text === 'fresh')).toBe(true)
    // The new conversation is the one resumed next time.
    expect(manager.isBusy(sessionId)).toBe(false)
    await manager.close()
  })

  it('sends a message typed right after stop once the stopped turn ends, instead of steering it into that turn', async () => {
    const { manager, events, state, steered, prompts, emit } = setup()
    state.onPrompt = (e) => e({ type: 'turn.started', turnId: `t${prompts.length}` })
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.prompt(sessionId, 'first')
    await until(() => events(sessionId).some((e) => e.type === 'turn.started'))
    const stopping = manager.interrupt(sessionId)
    const sent = await manager.prompt(sessionId, 'do this instead')
    await stopping
    expect(sent.state).toBe('queued')
    expect(steered).toEqual([])
    emit({ type: 'turn.completed', turnId: 't1', reason: 'cancelled' })
    await until(() => prompts.length === 2)
    expect(prompts[1]).toBe('do this instead')
    expect(events(sessionId).find((e) => e.type === 'prompt.dequeued')).toMatchObject({
      reason: 'sent',
    })
    await manager.close()
  })

  it('stops a turn whose tool runs far longer than any build, with its own message', async () => {
    const { manager, events, state, interrupted } = setup(60, 150)
    state.onPrompt = (e) => {
      e({ type: 'turn.started', turnId: 't1' })
      e({ type: 'tool.started', turnId: 't1', toolId: 'hang', title: 'Bash', kind: 'command' })
    }
    state.onInterrupt = (e) => e({ type: 'turn.completed', turnId: 't1', reason: 'cancelled' })
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.prompt(sessionId, 'hi')
    await until(() => events(sessionId).some((e) => e.type === 'turn.completed'))
    expect(interrupted).toHaveLength(1)
    expect(events(sessionId).find((e) => e.type === 'error')).toMatchObject({
      message: expect.stringMatching(/A tool the agent started has run for/),
    })
    await manager.close()
  })

  it('says the agent stopped before taking a message when its process dies first', async () => {
    const { manager, events, state, crash } = setup()
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    state.onPrompt = async () => {
      crash()
      await new Promise((r) => setTimeout(r, 20))
      throw new Error('The agent process ended')
    }
    await manager.prompt(sessionId, 'hi')
    await until(() => events(sessionId).some((e) => e.type === 'error'))
    expect(events(sessionId).find((e) => e.type === 'error')).toMatchObject({
      message: expect.stringMatching(/stopped before it could take this message/),
    })
    expect(events(sessionId).some((e) => e.type === 'turn.completed')).toBe(false)
    expect(manager.isBusy(sessionId)).toBe(false)
    await manager.close()
  })

  it('says to sign in again when the agent reports it is signed out', async () => {
    const { manager, events, state } = setup()
    state.onPrompt = (e) => {
      e({ type: 'turn.started', turnId: 't1' })
      e({ type: 'error', turnId: 't1', message: 'Invalid API key · Please run /login' })
      e({ type: 'turn.completed', turnId: 't1', reason: 'error' })
    }
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.prompt(sessionId, 'hi')
    await until(() => events(sessionId).some((e) => e.type === 'turn.completed'))
    expect(events(sessionId).find((e) => e.type === 'error')).toMatchObject({
      message: expect.stringMatching(/Please run \/login\n\nThe agent needs you to sign in again/),
    })
    await manager.close()
  })

  it('looks for an agent again when it was missing a moment ago, and says what to do when it still is', async () => {
    const { manager, instance } = setup()
    instance.status = 'not-installed'
    await expect(manager.create({ instanceId: 'stub' })).rejects.toThrow(
      /not installed on the host/,
    )
    instance.status = 'ready'
    // Detection is cached for a minute, but a missing agent is looked for again.
    await expect(manager.create({ instanceId: 'stub' })).resolves.toHaveProperty('sessionId')
    await manager.close()
  })

  it('keeps the end of a turn the full disk refused, and saves it once there is room', async () => {
    const { manager, events, state, emit, store } = setup(0, 40)
    const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db
    state.onPrompt = (e) => e({ type: 'turn.started', turnId: 't1' })
    const { sessionId } = await manager.create({ instanceId: 'stub' })
    await manager.prompt(sessionId, 'hi')
    await until(() => events(sessionId).some((e) => e.type === 'turn.started'))
    const { page_count } = db.prepare('PRAGMA page_count').get() as { page_count: number }
    db.exec(`PRAGMA max_page_count = ${page_count}`)
    // Fill what room is left, so even a small event no longer fits.
    for (let i = 0; i < 10_000; i++) {
      try {
        store.append({
          type: 'session.renamed',
          sessionId: 'filler',
          at: Date.now(),
          title: `${i}`,
        })
      } catch {
        break
      }
    }
    emit({ type: 'message.delta', turnId: 't1', role: 'assistant', text: 'x'.repeat(64 * 1024) })
    emit({ type: 'turn.completed', turnId: 't1', reason: 'done' })
    await until(() => !manager.isBusy(sessionId))
    expect(events(sessionId).some((e) => e.type === 'turn.completed')).toBe(false)

    db.exec('PRAGMA max_page_count = 1000000')
    await until(() => events(sessionId).some((e) => e.type === 'turn.completed'))
    await manager.close()
  })
})
