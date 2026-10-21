import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { EventStore } from './eventStore.ts'

const turnStarted = (sessionId: string): SessionEvent => ({
  type: 'turn.started',
  sessionId,
  at: 1,
})

describe('EventStore', () => {
  it('assigns increasing sequence numbers and replays after a cursor', () => {
    const store = new EventStore(':memory:')
    const a = store.append(turnStarted('s1'))
    const b = store.append(turnStarted('s2'))
    const c = store.append(turnStarted('s1'))
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect(store.readAfter(1).map((e) => e.seq)).toEqual([2, 3])
    expect(store.readAfter(3)).toEqual([])
    expect(store.lastSeq()).toBe(3)
  })

  it('notifies listeners after the event is committed', () => {
    const store = new EventStore(':memory:')
    const seen: number[] = []
    const off = store.subscribe((s) => {
      expect(store.lastSeq()).toBe(s.seq)
      seen.push(s.seq)
    })
    store.append(turnStarted('s1'))
    off()
    store.append(turnStarted('s1'))
    expect(seen).toEqual([1])
  })

  it('rejects invalid events', () => {
    const store = new EventStore(':memory:')
    expect(() => store.append({ type: 'nope' } as unknown as SessionEvent)).toThrow()
  })
})
