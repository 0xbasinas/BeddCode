import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  data: null as string | null,
  runtime: { connection: 'connecting', synced: false, replica: { sessions: { s: { turns: 1 } } } },
  listener: undefined as (() => void) | undefined,
  request: vi.fn(),
  writes: [] as string[],
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => mocks.data,
    setItem: async (_key: string, value: string) => {
      mocks.data = value
      mocks.writes.push(value)
    },
  },
}))
vi.mock('./store', () => ({
  hostRequest: mocks.request,
  useHostStore: {
    getState: () => ({ runtimes: { h: mocks.runtime } }),
    subscribe: (listener: () => void) => {
      mocks.listener = listener
    },
  },
}))

beforeEach(() => {
  vi.resetModules()
  mocks.data = null
  mocks.writes = []
  mocks.runtime = {
    connection: 'connecting',
    synced: false,
    replica: { sessions: { s: { turns: 1 } } },
  }
  mocks.request.mockReset()
})

const message = (text: string) => ({
  hostKey: 'h',
  sessionId: 's',
  text,
  attachments: [],
  mode: 'queue' as const,
  turns: 1,
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('offline queue delivery', () => {
  it('persists and sends messages in order after replay, with stable ids', async () => {
    const queue = await import('./offlineQueue')
    await queue.startOfflineQueue()
    await queue.enqueueMessage(message('first'))
    await queue.enqueueMessage(message('second'))
    const ids = queue.useOfflineQueue.getState().items.map((item) => item.id)
    expect(JSON.parse(mocks.data!).map((item: { text: string }) => item.text)).toEqual([
      'first',
      'second',
    ])
    mocks.request.mockResolvedValue({ state: 'queued' })
    mocks.runtime.connection = 'connected'
    mocks.listener?.()
    await settle()
    expect(mocks.request).not.toHaveBeenCalled()
    mocks.runtime.synced = true
    mocks.listener?.()
    await settle()
    expect(mocks.request.mock.calls.map((call) => [call[2].text, call[2].clientMessageId])).toEqual(
      [
        ['first', ids[0]],
        ['second', ids[1]],
      ],
    )
    expect(queue.useOfflineQueue.getState().items).toEqual([])
  })

  it('stops after an ambiguous send and retains the remaining messages', async () => {
    const queue = await import('./offlineQueue')
    await queue.startOfflineQueue()
    await queue.enqueueMessage(message('first'))
    await queue.enqueueMessage(message('second'))
    mocks.request.mockRejectedValue(new Error('connection lost'))
    mocks.runtime.connection = 'connected'
    mocks.runtime.synced = true
    mocks.listener?.()
    await settle()
    expect(queue.useOfflineQueue.getState().items.map((item) => item.state)).toEqual([
      'uncertain',
      'queued',
    ])
    mocks.listener?.()
    await settle()
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
})
