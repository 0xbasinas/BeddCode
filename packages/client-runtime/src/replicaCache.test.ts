import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyReplica } from './replica.ts'
import {
  decodeSnapshot,
  encodeSnapshot,
  MAX_SNAPSHOT_CHARS,
  ReplicaSaver,
  SNAPSHOT_VERSION,
  type ReplicaSnapshot,
} from './replicaCache.ts'

const snap = (over: Partial<ReplicaSnapshot> = {}): ReplicaSnapshot => ({
  v: SNAPSHOT_VERSION,
  logId: 'log',
  seq: 5,
  replica: { ...emptyReplica(), lastSeq: 5 },
  ...over,
})

describe('snapshot', () => {
  it('survives a round trip', () => {
    expect(decodeSnapshot(encodeSnapshot(snap()))).toEqual(snap())
  })

  it('is not trusted when damaged, from another version, or ahead of itself', () => {
    expect(decodeSnapshot(null)).toBeNull()
    expect(decodeSnapshot('{not json')).toBeNull()
    expect(decodeSnapshot(JSON.stringify(snap({ v: SNAPSHOT_VERSION + 1 })))).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ ...snap(), logId: undefined }))).toBeNull()
    expect(decodeSnapshot(JSON.stringify(snap({ seq: 2 })))).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ ...snap(), replica: { lastSeq: 5 } }))).toBeNull()
  })

  it('is not kept when it would be huge', () => {
    const big = snap()
    big.replica.sessions = { x: 'y'.repeat(MAX_SNAPSHOT_CHARS) } as never
    expect(encodeSnapshot(big)).toBeNull()
  })
})

describe('ReplicaSaver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const make = (over: Partial<ConstructorParameters<typeof ReplicaSaver>[0]> = {}) => {
    const writes: (string | null)[] = []
    const saver = new ReplicaSaver({
      write: async (raw) => void writes.push(raw),
      snapshot: () => snap(),
      delayMs: 1000,
      maxWaitMs: 5000,
      ...over,
    })
    return { saver, writes }
  }

  it('waits for a quiet moment, and writes once for a burst', async () => {
    const { saver, writes } = make()
    for (let i = 0; i < 5; i++) {
      saver.touch()
      await vi.advanceTimersByTimeAsync(400)
    }
    expect(writes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toHaveLength(1)
  })

  it('still writes during a stream that never goes quiet', async () => {
    const { saver, writes } = make()
    for (let i = 0; i < 20; i++) {
      saver.touch()
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(writes.length).toBeGreaterThanOrEqual(1)
  })

  it('writes at once when flushed, and removes the copy when there is nothing to save', async () => {
    const { saver, writes } = make({ snapshot: () => null })
    await saver.flush()
    expect(writes).toEqual([null])
  })

  it('does nothing after being cancelled', async () => {
    const { saver, writes } = make()
    saver.touch()
    saver.cancel()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(writes).toHaveLength(0)
  })
})
