import { afterEach, expect, it, vi } from 'vitest'
import { createPoller } from './poll.ts'

afterEach(() => vi.useRealTimers())

it('waits for a slow request and collapses repeated refreshes into one follow-up', async () => {
  vi.useFakeTimers()
  let resolve!: (value: number) => void
  const load = vi.fn(
    () =>
      new Promise<number>((done) => {
        resolve = done
      }),
  )
  const value = vi.fn()
  const poll = createPoller({ load, value, error: vi.fn(), intervalMs: 4000 })
  poll.refresh()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(load).toHaveBeenCalledOnce()
  poll.refresh()
  poll.refresh()
  resolve(1)
  await vi.advanceTimersByTimeAsync(0)
  expect(value).toHaveBeenCalledWith(1)
  expect(load).toHaveBeenCalledTimes(2)
  poll.stop()
  resolve(2)
  await vi.runAllTimersAsync()
  expect(value).toHaveBeenCalledOnce()
})

it('retries after failure and skips hidden polling without losing the schedule', async () => {
  vi.useFakeTimers()
  let visible = true
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(2)
  const error = vi.fn()
  const value = vi.fn()
  const poll = createPoller({ load, error, value, intervalMs: 100, visible: () => visible })
  poll.refresh()
  await vi.advanceTimersByTimeAsync(0)
  expect(error).toHaveBeenCalledOnce()
  visible = false
  await vi.advanceTimersByTimeAsync(500)
  expect(load).toHaveBeenCalledOnce()
  visible = true
  await vi.advanceTimersByTimeAsync(100)
  expect(value).toHaveBeenCalledWith(2)
  poll.stop()
})
