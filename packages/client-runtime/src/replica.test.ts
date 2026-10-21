import { describe, expect, it } from 'vitest'
import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { applyEvent, emptyReplica, type ReplicaState } from './replica.ts'

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

describe('replica', () => {
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
