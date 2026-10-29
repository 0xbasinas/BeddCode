import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingCalls } from './pending.ts'

afterEach(() => vi.useRealTimers())

describe('gateway pending host calls', () => {
  it('fails only the disconnected host’s calls and ignores another socket’s reply', async () => {
    vi.useFakeTimers()
    const pending = new PendingCalls()
    const first = {} as WebSocket
    const second = {} as WebSocket
    const interrupted = pending.wait('1', first, 25000)
    const successful = pending.wait('2', second, 25000)
    pending.finish('2', { result: 'wrong' }, first)
    pending.disconnected(first)
    expect((await interrupted).error).toContain('may have started')
    expect(pending.size).toBe(1)
    pending.finish('2', { result: 'ok' }, second)
    expect(await successful).toEqual({ result: 'ok' })
    expect(pending.size).toBe(0)
  })

  it('times out without assuming the operation was cancelled', async () => {
    vi.useFakeTimers()
    const pending = new PendingCalls()
    const answer = pending.wait('1', {} as WebSocket, 25000)
    vi.advanceTimersByTime(25000)
    expect((await answer).error).toContain('may have started')
    expect(pending.size).toBe(0)
  })
})
