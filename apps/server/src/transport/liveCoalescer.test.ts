import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveCoalescer } from './liveCoalescer.ts'

let seq = 0
const delta = (text: string, over: Partial<SessionEvent> = {}): StoredEvent => ({
  seq: ++seq,
  event: {
    type: 'message.delta',
    sessionId: 's',
    turnId: 't',
    role: 'assistant',
    text,
    at: seq,
    ...over,
  } as SessionEvent,
})
const other = (): StoredEvent => ({
  seq: ++seq,
  event: {
    type: 'turn.completed',
    sessionId: 's',
    turnId: 't',
    reason: 'done',
    at: seq,
  } as SessionEvent,
})
const text = (s: StoredEvent) => (s.event.type === 'message.delta' ? s.event.text : s.event.type)

let now = 0
beforeEach(() => {
  vi.useFakeTimers()
  seq = 0
  now = 0
})
afterEach(() => vi.useRealTimers())

const make = () => {
  const out: StoredEvent[] = []
  const c = new LiveCoalescer(
    (s) => out.push(s),
    60,
    () => now,
  )
  return { c, out }
}
const advance = (ms: number) => {
  now += ms
  vi.advanceTimersByTime(ms)
}

describe('LiveCoalescer', () => {
  it('sends the first piece at once and joins the burst that follows', () => {
    const { c, out } = make()
    c.push(delta('a'))
    expect(out.map(text)).toEqual(['a'])
    c.push(delta('b'))
    c.push(delta('c'))
    c.push(delta('d'))
    expect(out.map(text)).toEqual(['a'])
    advance(60)
    expect(out.map(text)).toEqual(['a', 'bcd'])
    // The joined piece is stamped with its last seq, so a resume never repeats a piece.
    expect(out.at(-1)!.seq).toBe(4)
  })

  it('sends the next piece at once after a quiet moment', () => {
    const { c, out } = make()
    c.push(delta('a'))
    advance(200)
    c.push(delta('b'))
    expect(out.map(text)).toEqual(['a', 'b'])
  })

  it('sends held text before any other event, keeping seq order', () => {
    const { c, out } = make()
    c.push(delta('a'))
    c.push(delta('b'))
    c.push(other())
    expect(out.map(text)).toEqual(['a', 'b', 'turn.completed'])
    const seqs = out.map((s) => s.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
  })

  it('does not join text of another turn or session', () => {
    const { c, out } = make()
    c.push(delta('a'))
    c.push(delta('b'))
    c.push(delta('c', { turnId: 'u' }))
    c.push(delta('d', { sessionId: 'z' }))
    advance(200)
    expect(out.map(text)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('leaves user messages alone and drops what is held when disposed', () => {
    const { c, out } = make()
    c.push(delta('hi', { role: 'user' }))
    expect(out.map(text)).toEqual(['hi'])
    c.push(delta('a'))
    c.push(delta('b'))
    c.dispose()
    advance(200)
    expect(out.map(text)).toEqual(['hi', 'a'])
  })
})
