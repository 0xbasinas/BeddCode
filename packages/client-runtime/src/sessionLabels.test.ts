import { describe, expect, it } from 'vitest'
import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { applyEvent, emptyReplica, type ReplicaState } from './replica.ts'
import { activityLine, endedByDecline, sessionNote } from './sessionLabels.ts'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at'> : never

function session(events: Draft[]) {
  let state: ReplicaState = emptyReplica()
  events.forEach((e, i) => {
    const stored = { seq: i + 1, event: { sessionId: 's1', at: i, ...e } as SessionEvent }
    state = applyEvent(state, stored satisfies StoredEvent)
  })
  return state.sessions.s1!
}

const options = [
  { id: 'allow-once', label: 'Yes', kind: 'allow' as const },
  { id: 'reject-once', label: 'No, and tell Grok what to do differently', kind: 'deny' as const },
]
const start: Draft[] = [
  { type: 'session.created', title: 'Demo', cwd: '/w', instanceId: 'acp:grok' },
  { type: 'turn.started' },
  { type: 'tool.started', toolId: 't1', kind: 'edit', title: 'Edit README.md' },
  { type: 'approval.requested', requestId: 'r1', toolId: 't1', title: 'Edit?', options },
]

describe('a turn that ends on a "no"', () => {
  it('says the user declined, not that it was stopped, when the agent ends the turn on a deny', () => {
    const s = session([
      ...start,
      { type: 'approval.resolved', requestId: 'r1', optionId: 'reject-once' },
      { type: 'turn.completed', reason: 'cancelled' },
    ])
    expect(endedByDecline(s)).toBe(true)
    expect(activityLine(s)).toBe('You declined · tell the agent what to do instead')
    expect(sessionNote(s)).toBe('Declined')
  })

  it('still says Stopped when the user pressed Stop', () => {
    const s = session([...start, { type: 'turn.completed', reason: 'cancelled' }])
    expect(endedByDecline(s)).toBe(false)
    expect(activityLine(s)).toBe('Stopped · ready to continue')
    expect(sessionNote(s)).toBe('Stopped')
  })

  it('says Stopped when the agent carried on after the "no" and was then stopped', () => {
    const s = session([
      ...start,
      { type: 'approval.resolved', requestId: 'r1', optionId: 'reject-once' },
      { type: 'message.delta', role: 'assistant', text: 'OK, trying something else' },
      { type: 'turn.completed', reason: 'cancelled' },
    ])
    expect(sessionNote(s)).toBe('Stopped')
  })

  it('forgets the "no" when the next turn starts, and after an allow there is nothing to say', () => {
    const declined = [
      ...start,
      { type: 'approval.resolved', requestId: 'r1', optionId: 'reject-once' },
      { type: 'turn.completed', reason: 'cancelled' },
    ] satisfies Draft[]
    expect(session([...declined, { type: 'turn.started' }]).declined).toBeUndefined()
    const allowed = session([
      ...start,
      { type: 'approval.resolved', requestId: 'r1', optionId: 'allow-once' },
      { type: 'turn.completed', reason: 'cancelled' },
    ])
    expect(sessionNote(allowed)).toBe('Stopped')
  })
})
