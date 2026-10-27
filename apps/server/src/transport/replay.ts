import type { ServerFrame, StoredEvent } from '@beddcode/contracts'
import type { EventStore } from '../store/eventStore.ts'
import { ReplayCompactor } from '../store/compact.ts'

const READ_BATCH = 1000
const FRAME_BATCH = 100
const HIGH_WATER = 512 * 1024
const MAX_PENDING = 10_000
const STALL_MS = 15_000

/** Subscribe before yielding. Replay a fixed log prefix, then drain live events in order. */
export function replaySubscription(options: {
  store: EventStore
  afterSeq: number
  compact?: boolean
  batch?: boolean
  send(frame: ServerFrame): void
  backlog(): number
  live(stored: StoredEvent): void
  failed(): void
  caughtUp(events: number): void
}): () => void {
  const { store } = options
  const through = Math.max(options.afterSeq, store.lastSeq())
  const compactor = options.compact
    ? new ReplayCompactor(store.latestStateSeqs(options.afterSeq, through))
    : undefined
  let cursor = options.afterSeq
  let pending: StoredEvent[] = []
  let pendingChars = 0
  let replaying = true
  let disposed = false
  let count = 0
  let blockedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let ready: StoredEvent[] = []
  let offset = 0
  let exhausted = false
  const stop = store.subscribe((stored) => {
    if (!replaying) return options.live(stored)
    pending.push(stored)
    pendingChars += JSON.stringify(stored).length
    if (pending.length > MAX_PENDING || pendingChars > 16 * 1024 * 1024) fail()
  })
  const dispose = () => {
    disposed = true
    if (timer) clearTimeout(timer)
    stop()
    pending = []
    pendingChars = 0
    ready = []
  }
  function fail() {
    dispose()
    options.failed()
  }
  const schedule = (delay = 0) => {
    if (disposed) return
    timer = setTimeout(pump, delay)
  }
  function pump() {
    if (disposed) return
    if (options.backlog() > HIGH_WATER) {
      blockedAt ||= Date.now()
      if (Date.now() - blockedAt >= STALL_MS) return fail()
      return schedule(10)
    }
    blockedAt = 0
    if (offset < ready.length) {
      const end = Math.min(offset + FRAME_BATCH, ready.length)
      if (options.batch) options.send({ t: 'events', events: ready.slice(offset, end) })
      else {
        while (offset < end && !disposed && options.backlog() <= HIGH_WATER)
          options.send({ t: 'event', stored: ready[offset++]! })
      }
      if (options.batch) offset = end
      return schedule()
    }
    if (!exhausted) {
      const rows = store.readAfter(cursor, READ_BATCH, through)
      ready = compactor ? compactor.compact(rows) : rows
      offset = 0
      cursor = rows.at(-1)?.seq ?? cursor
      exhausted = rows.length < READ_BATCH || cursor >= through
      count += ready.length
      return schedule()
    }
    options.send({ t: 'caught-up', seq: through })
    replaying = false
    // No await between the marker and live delivery, so a new event cannot overtake this queue.
    for (const stored of pending) {
      if (disposed) break
      options.live(stored)
    }
    pending = []
    pendingChars = 0
    ready = []
    options.caughtUp(count)
  }
  schedule()
  return dispose
}
