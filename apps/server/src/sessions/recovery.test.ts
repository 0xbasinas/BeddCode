import { describe, expect, it } from 'vitest'
import { EventStore } from '../store/eventStore.ts'
import { recoverInterruptedTurns, takeInterruptedSessions } from './recovery.ts'

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
    expect(stale).toContainEqual(expect.objectContaining({ type: 'turn.interrupted', turnId: 't' }))
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
  it('does not duplicate a recovery marker if the host crashed while recording it', () => {
    const store = new EventStore(':memory:')
    store.append({ type: 'turn.started', sessionId: 's', turnId: 't', at: 1 })
    store.append({
      type: 'turn.interrupted',
      sessionId: 's',
      turnId: 't',
      message: 'Stopped',
      at: 2,
    })
    recoverInterruptedTurns(store)
    expect(
      store.readSession('s').filter(({ event }) => event.type === 'turn.interrupted'),
    ).toHaveLength(1)
    expect(store.readSession('s').at(-1)?.event.type).toBe('turn.completed')
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

  describe('host killed mid-turn without a shutdown marker', () => {
    const seed = (store: EventStore) => {
      store.append({
        type: 'session.created',
        sessionId: 's',
        title: 'Demo',
        cwd: '/w',
        instanceId: 'fake',
        at: 1,
      })
      store.append({
        type: 'session.provider-session',
        sessionId: 's',
        providerSessionId: 'native-1',
        at: 2,
      })
      store.append({ type: 'turn.started', sessionId: 's', turnId: 't', at: 3 })
      store.append({
        type: 'message.delta',
        sessionId: 's',
        role: 'user',
        text: 'edit apps/server',
        at: 4,
      })
    }

    it('resumes on its own and leaves a timeline marker', () => {
      const store = new EventStore(':memory:')
      seed(store)
      expect(recoverInterruptedTurns(store)).toEqual(['s'])
      const [resumed] = takeInterruptedSessions()
      expect(resumed).toMatchObject({ sessionId: 's', turnId: 't' })
      expect(resumed?.prompt?.text).toContain('edit apps/server')
      const events = store.readSession('s').map((r) => r.event)
      expect(events.map((e) => e.type)).not.toContain('turn.completed')
      expect(events.at(-1)).toMatchObject({
        type: 'session.notice',
        message: expect.stringContaining('resumed automatically'),
      })
      store.close()
    })

    it('stops after three resumes of the same turn and asks the user', () => {
      const store = new EventStore(':memory:')
      seed(store)
      for (let i = 0; i < 3; i++) {
        expect(recoverInterruptedTurns(store)).toEqual(['s'])
        takeInterruptedSessions()
      }
      expect(recoverInterruptedTurns(store)).toEqual([])
      const last = store.readSession('s').map((r) => r.event)
      expect(last.at(-2)).toMatchObject({ type: 'turn.interrupted' })
      expect(last.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'cancelled' })
      store.close()
    })

    it('keeps the old behaviour when auto-resume is off or ask', () => {
      for (const mode of ['off', 'ask'] as const) {
        const store = new EventStore(':memory:')
        seed(store)
        expect(recoverInterruptedTurns(store, mode)).toEqual([])
        expect(store.readSession('s').at(-1)?.event).toMatchObject({ type: 'turn.completed' })
        store.close()
      }
    })
  })

  it('keeps an intentionally interrupted turn open for automatic resume', () => {
    const store = new EventStore(':memory:')
    store.append({
      type: 'session.created',
      sessionId: 's',
      title: 'Demo',
      cwd: '/w',
      instanceId: 'fake',
      at: 1,
    })
    store.append({
      type: 'session.provider-session',
      sessionId: 's',
      providerSessionId: 'native-1',
      at: 2,
    })
    store.append({ type: 'turn.started', sessionId: 's', turnId: 't', at: 3 })
    store.append({
      type: 'message.delta',
      sessionId: 's',
      role: 'user',
      text: 'finish the task',
      at: 4,
    })
    store.append({
      type: 'host.updating',
      sessionId: 's',
      at: 5,
      message: 'Host is updating, back in a moment',
      providerSessionId: 'native-1',
      prompt: { text: 'finish the task', attachments: [] },
    })
    expect(recoverInterruptedTurns(store)).toEqual(['s'])
    expect(takeInterruptedSessions()).toEqual([
      { sessionId: 's', turnId: 't', prompt: { text: 'finish the task', attachments: [] } },
    ])
    expect(store.readSession('s').map((row) => row.event.type)).not.toContain('turn.completed')
    const reopened = store
      .readSession('s')
      .findLast(({ event }) => event.type === 'host.updating')?.event
    expect(reopened).toMatchObject({ type: 'host.updating', prompt: { text: 'finish the task' } })
    store.close()
  })

  it('reattaches, instead of cancelling, a turn whose agent is still running under the supervisor', () => {
    const store = new EventStore(':memory:')
    for (const sessionId of ['kept', 'lost']) {
      store.append({
        type: 'session.created',
        sessionId,
        title: 'Demo',
        cwd: '/w',
        instanceId: 'claude',
        at: 1,
      })
      store.append({ type: 'turn.started', sessionId, turnId: 't', at: 3 })
    }
    expect(recoverInterruptedTurns(store, 'auto', new Set(['kept']))).toEqual(['kept'])
    expect(takeInterruptedSessions()).toEqual([{ sessionId: 'kept', turnId: 't' }])
    const done = (id: string) =>
      store.readSession(id).some((r) => r.event.type === 'turn.completed')
    expect(done('kept')).toBe(false)
    expect(done('lost')).toBe(true)
    store.close()
  })
})
