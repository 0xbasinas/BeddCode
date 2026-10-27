import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerFrame, StoredEvent } from '@beddcode/contracts'
import { EventStore } from '../store/eventStore.ts'
import { replaySubscription } from './replay.ts'

afterEach(() => vi.useRealTimers())

describe('chunked replay', () => {
  it.each([false, true])(
    'keeps the replay/live boundary and cursor with compaction=%s',
    async (compact) => {
      vi.useFakeTimers()
      const store = new EventStore(':memory:')
      const frames: ServerFrame[] = []
      store.appendMany(
        Array.from({ length: 2200 }, (_, n) => ({
          type: 'message.delta' as const,
          sessionId: 's',
          at: n,
          role: 'assistant' as const,
          text: 'x',
          turnId: 't',
        })),
      )
      const live: StoredEvent[] = []
      const stop = replaySubscription({
        store,
        afterSeq: 0,
        compact,
        batch: true,
        send: (frame) => frames.push(frame),
        backlog: () => 0,
        live: (stored) => {
          frames.push({ t: 'event', stored })
          live.push(stored)
        },
        failed: () => {
          throw new Error('unexpected disconnect')
        },
        caughtUp: () => {},
      })
      await vi.advanceTimersToNextTimerAsync()
      // This arrives after replay has yielded, before its last database read.
      const fresh = store.append({
        type: 'turn.completed',
        sessionId: 's',
        at: 3000,
        reason: 'done',
      })
      await vi.runAllTimersAsync()
      const marker = frames.findIndex((f) => f.t === 'caught-up')
      expect(frames[marker]).toEqual({ t: 'caught-up', seq: 2200 })
      expect(live).toEqual([fresh])
      expect(frames[marker + 1]).toEqual({ t: 'event', stored: fresh })
      const replay = frames.slice(0, marker).flatMap((f) => (f.t === 'events' ? f.events : []))
      expect(
        replay.map((s) => (s.event.type === 'message.delta' ? s.event.text : '')).join(''),
      ).toBe('x'.repeat(2200))
      expect(replay[0]!.seq).toBe(1)
      stop()
      store.close()
    },
  )

  it('waits for backpressure and stops a consumer that never drains', async () => {
    vi.useFakeTimers()
    const store = new EventStore(':memory:')
    const send = vi.fn()
    const failed = vi.fn()
    const stop = replaySubscription({
      store,
      afterSeq: 0,
      send,
      backlog: () => 2 * 1024 * 1024,
      live: () => {},
      failed,
      caughtUp: () => {},
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(failed).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    stop()
    store.close()
  })

  it('cancels scheduled reads and detaches the live listener', async () => {
    vi.useFakeTimers()
    const store = new EventStore(':memory:')
    const send = vi.fn()
    const stop = replaySubscription({
      store,
      afterSeq: 0,
      send,
      backlog: () => 0,
      live: send,
      failed: vi.fn(),
      caughtUp: vi.fn(),
    })
    stop()
    store.append({ type: 'turn.started', sessionId: 's', at: 1 })
    await vi.runAllTimersAsync()
    expect(send).not.toHaveBeenCalled()
    store.close()
  })
})
