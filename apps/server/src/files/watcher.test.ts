import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import chokidar from 'chokidar'
import { FileWatchers } from './watcher.ts'

vi.mock('chokidar', () => ({ default: { watch: vi.fn() } }))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function setup() {
  vi.useFakeTimers()
  const instances: (EventEmitter & { close: ReturnType<typeof vi.fn> })[] = []
  vi.mocked(chokidar.watch).mockImplementation(() => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
    instances.push(watcher)
    return watcher as unknown as ReturnType<typeof chokidar.watch>
  })
  return { instances, watches: new FileWatchers() }
}

it('keeps subscriptions across errors, including clients arriving during retry', async () => {
  const { instances, watches } = setup()
  const first = vi.fn()
  const second = vi.fn()
  const release = watches.acquire('.', first)
  instances[0]!.emit('error', new Error('watch failed'))
  watches.acquire('.', second)
  release()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(instances).toHaveLength(2)
  instances[1]!.emit('change', 'hello.ts')
  await vi.advanceTimersByTimeAsync(120)
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
  await watches.closeAll()
})

it.each(['release', 'shutdown'])('cancels retry on %s', async (action) => {
  const { instances, watches } = setup()
  const release = watches.acquire('.', vi.fn())
  instances[0]!.emit('error', new Error('watch failed'))
  if (action === 'release') release()
  else await watches.closeAll()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(instances).toHaveLength(1)
})

it('backs off and retries when recreating the watcher throws', async () => {
  const { instances, watches } = setup()
  watches.acquire('.', vi.fn())
  instances[0]!.emit('error', new Error('watch failed'))
  vi.mocked(chokidar.watch).mockImplementationOnce(() => {
    throw new Error('still unavailable')
  })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(instances).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(instances).toHaveLength(2)
  await watches.closeAll()
})
