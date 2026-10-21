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
