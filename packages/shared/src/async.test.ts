import { describe, expect, it } from 'vitest'
import { createAsyncQueue, deferred } from './async.ts'

describe('deferred', () => {
  it('resolves from outside', async () => {
    const d = deferred<number>()
    d.resolve(7)
    await expect(d.promise).resolves.toBe(7)
  })
})

describe('createAsyncQueue', () => {
  it('delivers buffered and later items in order, then ends on close', async () => {
    const q = createAsyncQueue<number>()
    q.push(1)
    q.push(2)
    const seen: number[] = []
    const consumer = (async () => {
      for await (const n of q) seen.push(n)
    })()
    q.push(3)
    q.close()
    await consumer
    expect(seen).toEqual([1, 2, 3])
  })
})
