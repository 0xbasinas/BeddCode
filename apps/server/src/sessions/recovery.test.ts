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
  it('does not mark an already failed turn as interrupted', () => {
    const store = new EventStore(':memory:')
    store.append({ type: 'turn.started', sessionId: 's', at: 1 })
    store.append({ type: 'error', sessionId: 's', at: 2, message: 'Provider exited' })
    recoverInterruptedTurns(store)
    expect(store.lastSeq()).toBe(2)
    store.close()
  })
})
