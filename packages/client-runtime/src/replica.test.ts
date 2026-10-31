import { describe, expect, it } from 'vitest'
import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { applyEvent, applyEvents, emptyReplica, type ReplicaState } from './replica.ts'

const base = { sessionId: 's1', at: 1 }
type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at'> : never

function fold(events: Draft[]) {
  let state: ReplicaState = emptyReplica()
  events.forEach((e, i) => {
    const stored = { seq: i + 1, event: { ...base, ...e } as SessionEvent } satisfies StoredEvent
    state = applyEvent(state, stored)
  })
  return state
}

const created = {
  type: 'session.created' as const,
  title: 'Demo',
  cwd: '/work/demo',
  instanceId: 'fake',
}

it('batch application matches individual events, including reconnect duplicates and tool boundaries', () => {
  const events: SessionEvent[] = [
    { ...base, ...created },
    { ...base, type: 'turn.started', turnId: 't' },
    ...Array.from({ length: 300 }, (_, n) => ({
      ...base,
      at: n + 2,
      type: 'message.delta' as const,
      role: 'assistant' as const,
      text: `${n} `,
      turnId: 't',
    })),
    { ...base, type: 'tool.started', toolId: 'tool', title: 'Read', kind: 'read' },
    { ...base, type: 'message.delta', role: 'assistant', text: 'After tool', turnId: 't' },
    { ...base, type: 'turn.completed', reason: 'done', turnId: 't' },
  ]
  const stored = events.map((event, n) => ({ seq: n + 1, event }))
  const initial = emptyReplica()
  const expected = stored.reduce(applyEvent, initial)
  expect(applyEvents(initial, stored)).toEqual(expected)
  expect(initial).toEqual(emptyReplica())
  const warm = stored.slice(0, 120).reduce(applyEvent, initial)
  expect(applyEvents(warm, stored)).toEqual(expected)
  expect(applyEvents(expected, stored)).toBe(expected)
})

describe('compaction', () => {
  const items = (s: ReplicaState) => s.sessions.s1!.items.filter((i) => i.kind === 'compaction')

  it('shows one row that turns from running to done, with the sizes', () => {
    const s = fold([
      created,
      { type: 'turn.started' },
      { type: 'session.compaction', state: 'started', trigger: 'auto' },
      { type: 'session.compaction', state: 'finished', tokensBefore: 90000, tokensAfter: 8000 },
    ])
    expect(items(s)).toMatchObject([
      { state: 'done', trigger: 'auto', tokensBefore: 90000, tokensAfter: 8000 },
    ])
  })

  it('adds a done row when only the end is reported, and a failed one on failure', () => {
    const s = fold([
      created,
      { type: 'session.compaction', state: 'finished' },
      { type: 'session.compaction', state: 'started' },
      { type: 'session.compaction', state: 'failed' },
    ])
    expect(items(s).map((i) => (i.kind === 'compaction' ? i.state : ''))).toEqual([
      'done',
      'failed',
    ])
  })

  it('does not leave a row spinning when the turn ends', () => {
    const s = fold([
      created,
      { type: 'turn.started' },
      { type: 'session.compaction', state: 'started' },
      { type: 'turn.completed', reason: 'done' },
    ])
    expect(items(s)).toMatchObject([{ state: 'done' }])
  })
})

describe('replica', () => {
  it('keeps what a helper reported for the current task, and adds up what it used', () => {
    const s = fold([
      created,
      { type: 'turn.started' },
      { type: 'session.result', status: 'blocked', summary: 'Needs the key' },
      {
        type: 'session.usage',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 880,
        costUsd: 0.01,
      },
      { type: 'turn.completed', reason: 'done' },
      { type: 'session.usage', inputTokens: 50, outputTokens: 5 },
    ])
    expect(s.sessions.s1).toMatchObject({
      result: { status: 'blocked', summary: 'Needs the key' },
      usage: { tokens: 1055, costUsd: 0.01 },
    })
    // A new task starts without the old outcome.
    const next = applyEvent(s, {
      seq: 99,
      event: { ...base, type: 'turn.started' } as SessionEvent,
    })
    expect(next.sessions.s1!.result).toBeUndefined()
    expect(next.sessions.s1!.usage).toEqual({ tokens: 1055, costUsd: 0.01 })
  })
  it('keeps no-project grouping on replay and names it from the first message', () => {
    const s = fold([
      { ...created, title: 'New session', projectless: true, cwd: '/data/sessions/s1' },
      { type: 'message.delta', role: 'user', text: 'Help me plan a trip' },
      { type: 'message.delta', role: 'user', text: 'A later message' },
    ])
    expect(s.sessions.s1).toMatchObject({
      projectless: true,
      title: 'Help me plan a trip',
      cwd: '/data/sessions/s1',
    })
    const custom = fold([
      { ...created, title: 'My notes', projectless: true },
      { type: 'message.delta', role: 'user', text: 'Keep my title' },
    ])
    expect(custom.sessions.s1!.title).toBe('My notes')
    expect(fold([created]).sessions.s1!.projectless).toBeUndefined()
  })

  it('files a session as done without counting it as activity, and a new turn takes it back out', () => {
    const filed = fold([
      { ...created },
      { type: 'turn.started', turnId: 't1' },
      { type: 'turn.completed', reason: 'done', turnId: 't1' },
    ])
    const before = filed.sessions.s1!
    expect(before.done).toBeUndefined()
    const done = applyEvent(filed, {
      seq: 99,
      event: { sessionId: 's1', at: 500, type: 'session.done', done: true },
    })
    expect(done.sessions.s1).toMatchObject({
      done: true,
      updatedAt: before.updatedAt,
      status: 'idle',
    })
    const back = applyEvent(done, {
      seq: 100,
      event: { sessionId: 's1', at: 600, type: 'session.done', done: false },
    })
    expect(back.sessions.s1!.done).toBeUndefined()
    const again = applyEvent(done, {
      seq: 101,
      event: { sessionId: 's1', at: 700, type: 'turn.started', turnId: 't2' },
    })
    expect(again.sessions.s1).toMatchObject({ done: undefined, status: 'running' })
  })

  it('marks a session as waiting on the user, and a new turn clears the mark', () => {
    const idle = fold([
      { ...created },
      { type: 'turn.started', turnId: 't1' },
      { type: 'turn.completed', reason: 'done', turnId: 't1' },
    ])
    const marked = applyEvent(idle, {
      seq: 99,
      event: {
        sessionId: 's1',
        at: 500,
        type: 'session.waiting',
        waiting: true,
        note: 'review',
        remindAt: 900,
      },
    })
    expect(marked.sessions.s1!.waitingMark).toEqual({ note: 'review', remindAt: 900, since: 500 })
    expect(marked.sessions.s1!.updatedAt).toBe(idle.sessions.s1!.updatedAt)
    const sent = applyEvent(marked, {
      seq: 100,
      event: { sessionId: 's1', at: 600, type: 'turn.started', turnId: 't2' },
    })
    expect(sent.sessions.s1!.waitingMark).toBeUndefined()
  })

  it('drops a deleted session, and ignores late events for it', () => {
    const state = fold([{ ...created }, { type: 'turn.started', turnId: 't1' }])
    expect(state.sessions.s1).toBeDefined()
    const gone = applyEvent(state, {
      seq: 99,
      event: { sessionId: 's1', at: 500, type: 'session.deleted' },
    })
    expect(gone.sessions.s1).toBeUndefined()
    expect(gone.order).not.toContain('s1')
    const late = applyEvent(gone, {
      seq: 100,
      event: { sessionId: 's1', at: 600, type: 'turn.started', turnId: 't2' },
    })
    expect(late.sessions.s1).toBeUndefined()
  })

  it('merges assistant deltas of one turn into a single message', () => {
    const s = fold([
      created,
      { type: 'turn.started', turnId: 't1' },
      { type: 'message.delta', role: 'assistant', text: 'Hel', turnId: 't1' },
      { type: 'message.delta', role: 'assistant', text: 'lo', turnId: 't1' },
    ])
    const view = s.sessions.s1!
    expect(view.items).toHaveLength(1)
    expect(view.items[0]).toMatchObject({ kind: 'message', text: 'Hello' })
    expect(view.status).toBe('running')
  })

  it('tracks tools, diffs and approvals, and derives status', () => {
    const s = fold([
      created,
      { type: 'tool.started', toolId: 'a', kind: 'command', title: 'ls' },
      { type: 'tool.completed', toolId: 'a', ok: true },
      { type: 'diff', path: 'x.ts', added: 3, removed: 1, patch: '' },
      {
        type: 'approval.requested',
        requestId: 'r1',
        title: 'Run?',
        options: [{ id: 'allow', label: 'Allow', kind: 'allow' }],
      },
    ])
    const view = s.sessions.s1!
    expect(view.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'ok', at: 1 })
    expect([view.added, view.removed]).toEqual([3, 1])
    expect(view.status).toBe('needs-you')

    const resolved = applyEvent(s, {
      seq: 99,
      event: { ...base, type: 'approval.resolved', requestId: 'r1', optionId: 'allow' },
    })
    expect(resolved.sessions.s1!.status).toBe('running')
    const done = applyEvent(resolved, {
      seq: 100,
      event: { ...base, type: 'turn.completed', reason: 'done' },
    })
    expect(done.sessions.s1!.status).toBe('idle')
  })

  it('ignores events at or below the last applied seq', () => {
    const s = fold([created, { type: 'turn.started' }])
    const again = applyEvent(s, {
      seq: 2,
      event: { ...base, type: 'turn.completed', reason: 'done' },
    })
    expect(again).toBe(s)
  })

  it('orders sessions newest first', () => {
    let s = emptyReplica()
    s = applyEvent(s, { seq: 1, event: { ...base, sessionId: 'a', ...created } })
    s = applyEvent(s, { seq: 2, event: { ...base, sessionId: 'b', ...created } })
    expect(s.order).toEqual(['b', 'a'])
  })

  it('names default sessions from their first message while preserving custom and renamed titles', () => {
    const initial = { ...created, title: 'Session in demo' }
    const s = fold([
      initial,
      { type: 'message.delta', role: 'user', text: '  Find the failing test\nand fix it  ' },
    ])
    expect(s.sessions.s1!.title).toBe('Find the failing test and fix it')
    const renamed = applyEvent(s, {
      seq: 20,
      event: { ...base, type: 'session.renamed', title: 'Release blocker' },
    })
    expect(renamed.sessions.s1!.title).toBe('Release blocker')
    expect(
      fold([created, { type: 'message.delta', role: 'user', text: 'Different prompt' }]).sessions
        .s1!.title,
    ).toBe('Demo')
  })

  it('keeps Needs you until every pending approval has been answered', () => {
    const request = (requestId: string): Draft => ({
      type: 'approval.requested',
      requestId,
      title: 'Run?',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow' }],
    })
    const s = fold([
      created,
      { type: 'turn.started' },
      request('r1'),
      request('r2'),
      { type: 'approval.resolved', requestId: 'r1', optionId: 'allow' },
    ])
    expect(s.sessions.s1!.status).toBe('needs-you')
    expect(
      applyEvent(s, {
        seq: 20,
        event: { ...base, type: 'approval.resolved', requestId: 'r2', optionId: 'allow' },
      }).sessions.s1!.status,
    ).toBe('running')
  })

  it('marks unfinished tools and requests as cancelled after a host interruption, with a notice', () => {
    const s = fold([
      created,
      { type: 'turn.started' },
      { type: 'tool.started', toolId: 'x', kind: 'command', title: 'Running test' },
      { type: 'approval.requested', requestId: 'r', title: 'Run?', options: [] },
      { type: 'turn.completed', reason: 'cancelled', message: 'Host restarted' },
    ]).sessions.s1!
    expect(s).toMatchObject({ status: 'idle', lastTurnReason: 'cancelled' })
    expect(s.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'cancelled' })
    expect(s.items.find((i) => i.kind === 'approval')).toMatchObject({ cancelled: true })
    expect(s.items.at(-1)).toMatchObject({ kind: 'notice', message: 'Host restarted' })
  })
})

describe('replica: queue, plan, questions and agent extras', () => {
  it('keeps messages typed while the agent works until they are sent or cancelled', () => {
    const s = fold([
      created,
      {
        type: 'prompt.queued',
        queueId: 'q1',
        text: 'first',
        attachments: [{ name: 'a.png', path: '/a.png' }],
      },
      { type: 'prompt.queued', queueId: 'q2', text: 'second' },
      { type: 'prompt.dequeued', queueId: 'q1', reason: 'sent' },
    ])
    expect(s.sessions.s1!.queue).toEqual([{ queueId: 'q2', text: 'second', attachments: [] }])
    expect(
      fold([
        created,
        { type: 'prompt.queued', queueId: 'q', text: 'x' },
        { type: 'prompt.dequeued', queueId: 'q', reason: 'cancelled' },
      ]).sessions.s1!.queue,
    ).toEqual([])
  })

  it("holds the agent's latest plan, commands and settings", () => {
    const s = fold([
      created,
      { type: 'plan.updated', steps: [{ text: 'A', status: 'pending' }] },
      {
        type: 'plan.updated',
        steps: [
          { text: 'A', status: 'completed' },
          { text: 'B', status: 'in-progress' },
        ],
        explanation: 'why',
      },
      { type: 'session.commands', commands: [{ name: 'review' }] },
      {
        type: 'session.config',
        options: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            value: 'fast',
            choices: [{ value: 'fast', name: 'Fast' }],
          },
        ],
      },
    ])
    const view = s.sessions.s1!
    expect(view.plan).toEqual({
      steps: [
        { text: 'A', status: 'completed' },
        { text: 'B', status: 'in-progress' },
      ],
      explanation: 'why',
    })
    expect(view.commands).toEqual([{ name: 'review' }])
    expect(view.config[0]).toMatchObject({ id: 'model', value: 'fast' })
  })

  it('waits on a question, then continues once it is answered', () => {
    const asked = fold([
      created,
      { type: 'turn.started', turnId: 't1' },
      {
        type: 'question.requested',
        requestId: 'r1',
        questions: [{ id: 'q0', question: 'Which?', options: [{ label: 'A' }] }],
      },
    ])
    expect(asked.sessions.s1!.status).toBe('needs-you')
    expect(asked.sessions.s1!.items.at(-1)).toMatchObject({ kind: 'question', requestId: 'r1' })

    const answered = fold([
      created,
      { type: 'turn.started', turnId: 't1' },
      {
        type: 'question.requested',
        requestId: 'r1',
        questions: [{ id: 'q0', question: 'Which?' }],
      },
      { type: 'question.resolved', requestId: 'r1', answers: { q0: ['A'] } },
    ])
    expect(answered.sessions.s1!.status).toBe('running')
    expect(answered.sessions.s1!.items.at(-1)).toMatchObject({
      answers: { q0: ['A'] },
      dismissed: false,
    })
  })

  it('treats a dismissed question as closed, and one left open when the turn ends', () => {
    const dismissed = fold([
      created,
      { type: 'turn.started', turnId: 't1' },
      {
        type: 'question.requested',
        requestId: 'r1',
        questions: [{ id: 'q0', question: 'Which?' }],
      },
      { type: 'question.resolved', requestId: 'r1' },
    ])
    expect(dismissed.sessions.s1!.items.at(-1)).toMatchObject({ dismissed: true })
    expect(dismissed.sessions.s1!.status).toBe('running')

    const ended = fold([
      created,
      { type: 'turn.started', turnId: 't1' },
      {
        type: 'question.requested',
        requestId: 'r1',
        questions: [{ id: 'q0', question: 'Which?' }],
      },
      { type: 'turn.completed', reason: 'cancelled' },
    ])
    expect(ended.sessions.s1!.items.at(-1)).toMatchObject({ dismissed: true })
    expect(ended.sessions.s1!.status).toBe('idle')
  })

  it('stays "needs you" while any approval or question is still open', () => {
    const s = fold([
      created,
      { type: 'turn.started', turnId: 't1' },
      { type: 'approval.requested', requestId: 'a1', title: 'Run?', options: [] },
      { type: 'question.requested', requestId: 'q1', questions: [{ id: 'x', question: '?' }] },
      { type: 'approval.resolved', requestId: 'a1', optionId: 'allow' },
    ])
    expect(s.sessions.s1!.status).toBe('needs-you')
  })

  it('carries a plan on an approval and the fork/import markers on a session', () => {
    const s = fold([
      { ...created, forkedFrom: { sessionId: 'orig', title: 'Original' }, imported: true },
      {
        type: 'approval.requested',
        requestId: 'a1',
        title: 'Start?',
        plan: '1. Do it',
        options: [],
      },
    ])
    const view = s.sessions.s1!
    expect(view.forkedFrom).toEqual({ sessionId: 'orig', title: 'Original' })
    expect(view.imported).toBe(true)
    expect(view.items[0]).toMatchObject({ kind: 'approval', plan: '1. Do it' })
  })
})

describe('replica: model changes', () => {
  it('shows the model and effort the user switched to', () => {
    const s = fold([
      { ...created, model: 'sonnet', effort: 'low' } as never,
      { type: 'session.model', model: 'opus', effort: 'high' },
    ])
    expect(s.sessions.s1).toMatchObject({ model: 'opus', effort: 'high' })
    const back = fold([
      { ...created, model: 'sonnet' } as never,
      { type: 'session.model', model: 'opus' },
      { type: 'session.model' },
    ])
    expect(back.sessions.s1!.model).toBeUndefined()
  })
})

describe('replica: tool approvals', () => {
  const timed = (events: (Draft & { at: number })[]) => {
    let state: ReplicaState = emptyReplica()
    events.forEach((e, i) => {
      state = applyEvent(state, { seq: i + 1, event: { ...base, ...e } as SessionEvent })
    })
    return state.sessions.s1!
  }
  const tool = (s: ReturnType<typeof timed>, id: string) =>
    s.items.find((i) => i.kind === 'tool' && i.id === id) as Extract<
      (typeof s.items)[number],
      { kind: 'tool' }
    >

  it('links an approval to its tool, so the row knows when the user answered', () => {
    const options = [
      { id: 'allow-once', label: 'Yes', kind: 'allow' as const },
      { id: 'reject-once', label: 'No', kind: 'deny' as const },
    ]
    const asked = timed([
      { ...created, at: 0 },
      { type: 'turn.started', at: 0 },
      { type: 'tool.started', toolId: 't1', kind: 'command', title: 'run', at: 1_000 },
      {
        type: 'approval.requested',
        requestId: 'r1',
        toolId: 't1',
        title: 'Run?',
        options,
        at: 1_005,
      },
    ])
    expect(tool(asked, 't1').approval).toEqual({ requestId: 'r1', requestedAt: 1_005 })

    const answered = timed([
      { ...created, at: 0 },
      { type: 'turn.started', at: 0 },
      { type: 'tool.started', toolId: 't1', kind: 'command', title: 'run', at: 1_000 },
      {
        type: 'approval.requested',
        requestId: 'r1',
        toolId: 't1',
        title: 'Run?',
        options,
        at: 1_005,
      },
      { type: 'approval.resolved', requestId: 'r1', optionId: 'allow-once', at: 17_000 },
      { type: 'tool.completed', toolId: 't1', ok: true, approval: 'asked', at: 17_030 },
    ])
    expect(tool(answered, 't1')).toMatchObject({
      status: 'ok',
      asked: true,
      endedAt: 17_030,
      approval: { requestId: 'r1', requestedAt: 1_005, resolvedAt: 17_000, outcome: 'allow' },
    })
  })

  it('refines a tool title and kind, and marks tools the agent ran without asking', () => {
    const s = timed([
      { ...created, at: 0 },
      { type: 'turn.started', at: 0 },
      { type: 'tool.started', toolId: 't2', kind: 'other', title: 'run_terminal_command', at: 1 },
      { type: 'tool.updated', toolId: 't2', kind: 'command', title: 'Execute `ls`', at: 2 },
      { type: 'tool.completed', toolId: 't2', ok: true, approval: 'not-asked', at: 3 },
    ])
    expect(tool(s, 't2')).toMatchObject({
      title: 'Execute `ls`',
      toolKind: 'command',
      asked: false,
      status: 'ok',
    })
    expect(tool(s, 't2').approval).toBeUndefined()
  })

  it("keeps a tool call's input and paths, refined by later updates", () => {
    const s = timed([
      { ...created, at: 0 },
      { type: 'turn.started', at: 0 },
      { type: 'tool.started', toolId: 't3', kind: 'read', title: 'read_file', input: '{}', at: 1 },
      {
        type: 'tool.updated',
        toolId: 't3',
        input: '{\n  "path": "/a/b.md"\n}',
        paths: ['/a/b.md'],
        at: 2,
      },
      { type: 'tool.completed', toolId: 't3', ok: true, output: '# b', at: 3 },
    ])
    expect(tool(s, 't3')).toMatchObject({
      input: '{\n  "path": "/a/b.md"\n}',
      paths: ['/a/b.md'],
      output: '# b',
    })
  })
})
