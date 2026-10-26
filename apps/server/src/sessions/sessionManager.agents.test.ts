import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentPreview, SessionEvent } from '@beddcode/contracts'
import { createFakeAdapter } from '@beddcode/provider-core'
import { createLogger } from '@beddcode/shared'
import { PreviewCache } from '../agents/previews.ts'
import { AttachmentStore } from '../attachments/store.ts'
import { EventStore } from '../store/eventStore.ts'
import { GitService } from '../workspace/git.ts'
import { SessionManager } from './sessionManager.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function setup(options: Parameters<typeof createFakeAdapter>[0] = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-agents-'))
  dirs.push(dir)
  const store = new EventStore(':memory:')
  const manager = new SessionManager({
    store,
    attachments: new AttachmentStore(path.join(dir, 'attachments')),
    git: new GitService(),
    adapters: [createFakeAdapter({ delayMs: 20, ...options })],
    log: createLogger('test', 'error'),
    defaultCwd: dir,
  })
  const events = (sessionId: string): SessionEvent[] =>
    store.readSession(sessionId).map((e) => e.event)
  const types = (sessionId: string) => events(sessionId).map((e) => e.type)
  const waitFor = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 400; i++) {
      if (check()) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const turnsDone = (id: string) => types(id).filter((t) => t === 'turn.completed').length
  return { dir, store, manager, events, types, waitFor, turnsDone }
}

describe('queued and steered messages', () => {
  it('queues a message sent while the agent works and sends it when the turn ends', async () => {
    const { manager, events, types, waitFor, turnsDone } = setup()
    const { sessionId } = await manager.create({ instanceId: 'fake', permissionMode: 'full' })

    expect((await manager.prompt(sessionId, 'first')).state).toBe('started')
    const queued = await manager.prompt(sessionId, 'second')
    expect(queued.state).toBe('queued')
    expect(types(sessionId)).toContain('prompt.queued')

    await waitFor(() => turnsDone(sessionId) === 2, 'both turns')
    const log = events(sessionId)
    expect(log.find((e) => e.type === 'prompt.dequeued')).toMatchObject({
      queueId: queued.queueId,
      reason: 'sent',
    })
    const userMessages = log.flatMap((e) =>
      e.type === 'message.delta' && e.role === 'user' ? [e.text] : [],
    )
    expect(userMessages).toEqual(['first', 'second'])
  })

  it('cancels a queued message without sending it', async () => {
    const { manager, events, waitFor, turnsDone } = setup()
    const { sessionId } = await manager.create({ instanceId: 'fake', permissionMode: 'full' })
    await manager.prompt(sessionId, 'first')
    const { queueId } = await manager.prompt(sessionId, 'second')
    await manager.dequeue(sessionId, queueId!, 'cancel')
    await waitFor(() => turnsDone(sessionId) === 1, 'the first turn')
    await new Promise((r) => setTimeout(r, 80))

    expect(turnsDone(sessionId)).toBe(1)
    expect(events(sessionId).find((e) => e.type === 'prompt.dequeued')).toMatchObject({
      reason: 'cancelled',
    })
    await expect(manager.dequeue(sessionId, queueId!, 'cancel')).rejects.toThrow(
      'no longer waiting',
    )
  })

  it('interrupts and sends a queued message right away when the agent cannot be steered', async () => {
    const { manager, events, waitFor, turnsDone } = setup()
    const { sessionId } = await manager.create({ instanceId: 'fake', permissionMode: 'full' })
    await manager.prompt(sessionId, 'first')
    const { queueId } = await manager.prompt(sessionId, 'urgent')
    await manager.dequeue(sessionId, queueId!, 'steer')

    await waitFor(() => turnsDone(sessionId) === 2, 'the interrupted and the new turn')
    const reasons = events(sessionId).flatMap((e) =>
      e.type === 'turn.completed' ? [e.reason] : [],
    )
    expect(reasons).toEqual(['cancelled', 'done'])
    expect(events(sessionId).find((e) => e.type === 'prompt.dequeued')).toMatchObject({
      reason: 'sent',
    })
  })

  it('steers into the running turn when the agent supports it, and queues on request', async () => {
    const { manager, events, types, waitFor, turnsDone } = setup({ advanced: true })
    const { sessionId } = await manager.create({ instanceId: 'fake', permissionMode: 'full' })
    await manager.prompt(sessionId, '[slow] first')

    expect((await manager.prompt(sessionId, 'also this')).state).toBe('steered')
    expect(types(sessionId)).not.toContain('prompt.queued')
    expect((await manager.prompt(sessionId, 'later please', [], 'queue')).state).toBe('queued')

    await waitFor(() => turnsDone(sessionId) === 2, 'both turns')
    const userMessages = events(sessionId).flatMap((e) =>
      e.type === 'message.delta' && e.role === 'user' ? [e.text] : [],
    )
    expect(userMessages).toEqual(['[slow] first', 'also this', 'later please'])
  })

  it('rebuilds waiting messages from the log after a restart', async () => {
    const { manager, store, dir, waitFor, turnsDone } = setup()
    const { sessionId } = await manager.create({ instanceId: 'fake', permissionMode: 'full' })
    await manager.prompt(sessionId, 'first')
    await manager.prompt(sessionId, 'waiting')
    await manager.close()

    const restarted = new SessionManager({
      store,
      attachments: new AttachmentStore(path.join(dir, 'attachments')),
      git: new GitService(),
      adapters: [createFakeAdapter({ delayMs: 0 })],
      log: createLogger('test', 'error'),
      defaultCwd: dir,
    })
    // The old process died mid-turn; the waiting message is still known and can be sent or dropped.
    const stored = store.readSession(sessionId).map((e) => e.event)
    const queueId = stored.find((e) => e.type === 'prompt.queued')
    expect(queueId).toBeTruthy()
    await expect(
      restarted.dequeue(
        sessionId,
        queueId?.type === 'prompt.queued' ? queueId.queueId : '',
        'cancel',
      ),
    ).resolves.toBeUndefined()
    void waitFor
    void turnsDone
  })
})

describe('questions', () => {
  it('relays an answer back to the agent and records it', async () => {
    const { manager, events, waitFor, turnsDone } = setup({ advanced: true })
    const { sessionId } = await manager.create({ instanceId: 'fake', permissionMode: 'full' })
    await manager.prompt(sessionId, '[question] pick')

    await waitFor(
      () => events(sessionId).some((e) => e.type === 'question.requested'),
      'the question',
    )
    const asked = events(sessionId).find((e) => e.type === 'question.requested')
    if (asked?.type !== 'question.requested') throw new Error('no question')
    expect(asked.questions[0]).toMatchObject({ question: 'Which database?' })

    await manager.answerQuestion(sessionId, asked.requestId, { db: ['SQLite'] })
    await waitFor(() => turnsDone(sessionId) === 1, 'the turn to finish')
    expect(events(sessionId).find((e) => e.type === 'question.resolved')).toMatchObject({
      answers: { db: ['SQLite'] },
    })
  })

  it('refuses to answer when the agent does not ask questions', async () => {
    const { manager } = setup()
    const { sessionId } = await manager.create({ instanceId: 'fake' })
    await expect(manager.answerQuestion(sessionId, 'q-1', {})).rejects.toThrow(
      'does not ask questions',
    )
  })
})

describe('history, import and fork', () => {
  const history = [
    {
      id: 'old-1',
      title: 'Fix the parser',
      updatedAt: 1_700_000_000_000,
      turns: [
        { user: 'why does it fail?', assistant: 'an off-by-one' },
        { user: 'fix it', assistant: 'done' },
      ],
    },
  ]

  it('lists stored conversations and imports one as a session that can be continued', async () => {
    const { manager, events, dir, waitFor, turnsDone } = setup({ advanced: true, history })
    const listed = await manager.listHistory('fake', dir)
    expect(listed).toEqual([
      { id: 'old-1', title: 'Fix the parser', updatedAt: 1_700_000_000_000, imported: false },
    ])

    const { sessionId } = await manager.importSession({
      instanceId: 'fake',
      providerSessionId: 'old-1',
      cwd: dir,
    })
    const log = events(sessionId)
    expect(log[0]).toMatchObject({
      type: 'session.created',
      imported: true,
      title: 'Fix the parser',
    })
    const said = log.flatMap((e) => (e.type === 'message.delta' ? [`${e.role}: ${e.text}`] : []))
    expect(said).toEqual([
      'user: why does it fail?',
      'assistant: an off-by-one',
      'user: fix it',
      'assistant: done',
    ])
    expect((await manager.listHistory('fake', dir))[0]?.imported).toBe(true)

    // The agent is not running yet; the first message resumes it.
    await manager.prompt(sessionId, 'carry on')
    await waitFor(() => events(sessionId).some((e) => e.type === 'approval.requested'), 'approval')
    const ask = events(sessionId).find((e) => e.type === 'approval.requested')
    if (ask?.type !== 'approval.requested') throw new Error('no approval')
    await manager.approve(sessionId, ask.requestId, 'allow')
    await waitFor(() => turnsDone(sessionId) === 3, 'the resumed turn')
  })

  it('imports the tool calls of a stored conversation, in order, with ids that cannot collide', async () => {
    const tool = (n: number) => [
      { type: 'tool.started', toolId: 'item-1', kind: 'command', title: `Running ${n}` },
      { type: 'tool.completed', toolId: 'item-1', ok: true, output: 'fine' },
    ]
    const stored = [
      {
        id: 'old-2',
        title: 'Tools',
        turns: [
          { user: 'a', assistant: 'x', events: tool(1) },
          {
            user: 'b',
            assistant: 'y',
            events: [...tool(2), { type: 'message.delta', role: 'assistant', text: 'y' }],
          },
        ],
      },
    ] as never
    const { manager, events, dir } = setup({ advanced: true, history: stored })
    const { sessionId } = await manager.importSession({
      instanceId: 'fake',
      providerSessionId: 'old-2',
      cwd: dir,
    })
    const log = events(sessionId)
    const ids = log.flatMap((e) => (e.type === 'tool.started' ? [e.toolId] : []))
    expect(ids).toEqual(['turn-1:item-1', 'turn-2:item-1'])
    // Written times are kept, and a tool that never finished is closed instead of left spinning.
    const timed = [
      {
        id: 'old-3',
        title: 'Timed',
        turns: [
          {
            user: 'go',
            assistant: '',
            events: [
              { type: 'tool.started', toolId: 'x', kind: 'command', title: 'Running', at: 1000 },
            ],
          },
        ],
      },
    ] as never
    const second = setup({ advanced: true, history: timed })
    const timedId = (
      await second.manager.importSession({
        instanceId: 'fake',
        providerSessionId: 'old-3',
        cwd: second.dir,
      })
    ).sessionId
    const timedLog = second.events(timedId)
    expect(timedLog.find((e) => e.type === 'tool.started')).toMatchObject({ at: 1000 })
    expect(timedLog.find((e) => e.type === 'tool.completed')).toMatchObject({
      toolId: 'turn-1:x',
      ok: false,
    })
    const kinds = log.filter((e) => e.turnId === 'turn-2').map((e) => e.type)
    expect(kinds).toEqual([
      'message.delta',
      'turn.started',
      'tool.started',
      'tool.completed',
      'message.delta',
      'turn.completed',
    ])
  })

  it('forks a session, keeping only the turns asked for', async () => {
    const { manager, events, dir, waitFor, turnsDone } = setup({ advanced: true })
    const { sessionId } = await manager.create({
      instanceId: 'fake',
      cwd: dir,
      permissionMode: 'full',
    })
    await manager.prompt(sessionId, 'one')
    await waitFor(() => turnsDone(sessionId) === 1, 'turn 1')
    await manager.prompt(sessionId, 'two')
    await waitFor(() => turnsDone(sessionId) === 2, 'turn 2')

    const { sessionId: forkId } = await manager.fork({ sessionId, throughTurn: 1 })
    const log = events(forkId)
    expect(log[0]).toMatchObject({
      type: 'session.created',
      forkedFrom: { sessionId },
      title: expect.stringContaining('(fork)'),
    })
    const users = log.flatMap((e) =>
      e.type === 'message.delta' && e.role === 'user' ? [e.text] : [],
    )
    expect(users).toEqual(['one'])
    expect(log.filter((e) => e.type === 'turn.completed')).toHaveLength(1)
    expect(log.every((e) => e.sessionId === forkId)).toBe(true)

    // The original is untouched, and the fork can be continued on its own.
    expect(turnsDone(sessionId)).toBe(2)
    await manager.prompt(forkId, 'three')
    await waitFor(() => turnsDone(forkId) === 2, 'the fork continuing')
    await expect(manager.fork({ sessionId, throughTurn: 9 })).rejects.toThrow('fewer than 9')
  })

  it('does not fork an agent that cannot', async () => {
    const { manager } = setup()
    const { sessionId } = await manager.create({ instanceId: 'fake' })
    await expect(manager.fork({ sessionId })).rejects.toThrow('Send a first message')
  })
})

describe('importing twice', () => {
  it('goes back to the session the conversation already is', async () => {
    const { manager, events, dir } = setup({
      advanced: true,
      history: [{ id: 'conv-1', title: 'Once', turns: [{ user: 'hi', assistant: 'hello' }] }],
    })
    const first = await manager.importSession({
      instanceId: 'fake',
      providerSessionId: 'conv-1',
      cwd: dir,
    })
    const again = await manager.importSession({
      instanceId: 'fake',
      providerSessionId: 'conv-1',
      cwd: dir,
    })
    expect(again.sessionId).toBe(first.sessionId)
    expect(events(first.sessionId).filter((e) => e.type === 'message.delta')).toHaveLength(2)
  })
})

describe('switching models', () => {
  it('records the change and uses it when the session is resumed', async () => {
    const started: { model?: string; effort?: string; resumeId?: string }[] = []
    const { manager, store, events, dir, waitFor, turnsDone } = setup({
      advanced: true,
      onStart: (input) =>
        started.push({ model: input.model, effort: input.effort, resumeId: input.resumeId }),
    })
    const { sessionId } = await manager.create({
      instanceId: 'fake',
      cwd: dir,
      permissionMode: 'full',
      model: 'fast',
      effort: 'low',
    })
    await manager.prompt(sessionId, 'one')
    await waitFor(() => turnsDone(sessionId) === 1, 'turn 1')

    await manager.setModel(sessionId, 'smart', 'high')
    expect(events(sessionId).findLast((e) => e.type === 'session.model')).toMatchObject({
      model: 'smart',
      effort: 'high',
    })

    // After a restart the session comes back on the model that was chosen last.
    await manager.close()
    const restarted = new SessionManager({
      store,
      attachments: new AttachmentStore(path.join(dir, 'attachments')),
      git: new GitService(),
      adapters: [
        createFakeAdapter({
          advanced: true,
          delayMs: 0,
          onStart: (input) =>
            started.push({ model: input.model, effort: input.effort, resumeId: input.resumeId }),
        }),
      ],
      log: createLogger('test', 'error'),
      defaultCwd: dir,
    })
    await restarted.prompt(sessionId, 'two')
    expect(started.at(-1)).toMatchObject({ model: 'smart', effort: 'high' })
    expect(started.at(-1)?.resumeId).toBeTruthy()
  })

  it('refuses agents that cannot switch models', async () => {
    const { manager } = setup()
    const { sessionId } = await manager.create({ instanceId: 'fake' })
    await expect(manager.setModel(sessionId, 'x', undefined)).rejects.toThrow(
      'does not let you change',
    )
  })
})

describe('previewing an agent', () => {
  it("answers from the agent's own capabilities when it has no probe", async () => {
    const { manager } = setup({ advanced: true })
    const preview = await manager.previewAgent('fake')
    expect(preview.modes.map((m) => m.id)).toEqual(['ask', 'full'])
    expect(preview.commands).toEqual([
      { name: 'review', description: 'Review the changes', kind: 'command' },
    ])
    expect(preview.config).toEqual([])
  })
})

describe('refreshing an old agent preview', () => {
  const offer = (model: string): AgentPreview => ({
    modes: [],
    config: [{ id: 'model', name: 'Model', type: 'select', value: model, choices: [] }],
    commands: [],
  })

  it('probes again once the remembered answer is old, and uses the fresh one', async () => {
    let now = 0
    const previews = new PreviewCache(undefined, () => now)
    let probes = 0
    const adapter = {
      ...createFakeAdapter(),
      preview: async () => {
        probes++
        return offer('grok-4.7')
      },
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-previews-'))
    dirs.push(dir)
    const manager = new SessionManager({
      store: new EventStore(':memory:'),
      attachments: new AttachmentStore(path.join(dir, 'attachments')),
      git: new GitService(),
      adapters: [adapter],
      log: createLogger('test', 'error'),
      defaultCwd: dir,
      previews,
    })
    previews.set('fake', offer('grok-4.6'))

    // Fresh enough: answered from memory without starting the agent.
    now = 60_000
    expect((await manager.previewAgent('fake')).config[0]?.value).toBe('grok-4.6')
    expect(probes).toBe(0)

    // Hours later the agent has updated itself; the new default shows.
    now = 3 * 60 * 60_000
    expect((await manager.previewAgent('fake')).config[0]?.value).toBe('grok-4.7')
    expect(probes).toBe(1)
    expect(previews.get('fake')?.config[0]?.value).toBe('grok-4.7')
  })
})
