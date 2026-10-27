import { describe, expect, it } from 'vitest'
import { EventStore } from '../store/eventStore.ts'
import { recoverInterruptedTurns } from './recovery.ts'

describe('interrupted turn recovery', () => {
  it('finishes interrupted turns once while preserving completed sessions and approval decisions', () => {
    const store = new EventStore(':memory:')
    for (const sessionId of ['stale', 'done']) {
      store.append({
        type: 'session.created',
        sessionId,
        title: 'Demo',
        cwd: '/w',
        instanceId: 'fake',
        at: 1,
      })
      store.append({ type: 'turn.started', sessionId, turnId: 't', at: 2 })
    }
    store.append({
      type: 'approval.requested',
      sessionId: 'stale',
      turnId: 't',
      at: 3,
      requestId: 'r',
      title: 'Run?',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow' }],
    })
    store.append({
      type: 'approval.resolved',
      sessionId: 'stale',
      turnId: 't',
      at: 4,
      requestId: 'r',
      optionId: 'allow',
    })
    store.append({ type: 'turn.completed', sessionId: 'done', turnId: 't', at: 5, reason: 'done' })
    recoverInterruptedTurns(store)
    const stale = store.readSession('stale').map((s) => s.event)
    expect(stale.at(-1)).toMatchObject({
      type: 'turn.completed',
      reason: 'cancelled',
      turnId: 't',
      message: expect.stringContaining('host restarted'),
    })
    expect(stale.filter((e) => e.type === 'approval.resolved')).toEqual([
      expect.objectContaining({ optionId: 'allow' }),
    ])
    expect(store.readSession('done')).toHaveLength(3)
    const seq = store.lastSeq()
    recoverInterruptedTurns(store)
    expect(store.lastSeq()).toBe(seq)
    store.close()
  })
  it('tells an agent which of the sessions it started were cut off with it', () => {
    const store = new EventStore(':memory:')
    const created = (sessionId: string, parent?: string) =>
      store.append({
        type: 'session.created',
        sessionId,
        title: sessionId,
        cwd: '/w',
        instanceId: 'fake',
        at: 1,
        parent: parent ? { sessionId: parent, depth: 1 } : undefined,
      })
    created('lead')
    created('a', 'lead')
    created('b', 'lead')
    created('finished', 'lead')
    for (const sessionId of ['lead', 'a', 'b', 'finished'])
      store.append({ type: 'turn.started', sessionId, at: 2 })
    store.append({ type: 'turn.completed', sessionId: 'finished', at: 3, reason: 'done' })
    recoverInterruptedTurns(store)
    const last = (id: string) => store.readSession(id).at(-1)?.event
    expect(last('lead')).toMatchObject({
      reason: 'cancelled',
      message: expect.stringContaining('2 sessions it started stopped too'),
    })
    expect(last('a')).toMatchObject({
      message: expect.not.stringContaining('started stopped'),
    })
    store.close()
  })
  it('does not mark an already failed turn as interrupted', () => {
    const store = new EventStore(':memory:')
    store.append({ type: 'turn.started', sessionId: 's', at: 1 })
    store.append({ type: 'error', sessionId: 's', at: 2, message: 'Provider exited' })
    recoverInterruptedTurns(store)
    expect(store.lastSeq()).toBe(2)
    store.close()
  })
})
