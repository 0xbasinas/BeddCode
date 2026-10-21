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
    expect(view.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'ok' })
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
})
