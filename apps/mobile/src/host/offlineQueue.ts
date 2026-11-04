import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { hostRequest, useHostStore } from './store'
import { needsReview, restoreQueue, type QueuedMessage } from './offlineQueueCore'

const KEY = 'beddcode.offline-messages.v1'
export const useOfflineQueue = create<{ items: QueuedMessage[] }>(() => ({ items: [] }))
let loaded = false
let writes = Promise.resolve()
const draining = new Set<string>()
const wakeAgain = new Set<string>()

// Serialize read-modify-write operations: a successful enqueue means it is on disk.
function change(update: (items: QueuedMessage[]) => QueuedMessage[]): Promise<void> {
  const operation = writes.then(async () => {
    const items = update(useOfflineQueue.getState().items)
    await AsyncStorage.setItem(KEY, JSON.stringify(items))
    useOfflineQueue.setState({ items })
  })
  writes = operation.catch(() => {})
  return operation
}

export async function startOfflineQueue() {
  if (loaded) return
  const raw = await AsyncStorage.getItem(KEY)
  const items: QueuedMessage[] = raw ? JSON.parse(raw) : []
  await AsyncStorage.setItem(KEY, JSON.stringify(restoreQueue(items)))
  useOfflineQueue.setState({ items: restoreQueue(items) })
  loaded = true
  useHostStore.subscribe(() => {
    for (const hostKey of new Set(useOfflineQueue.getState().items.map((item) => item.hostKey))) {
      void drain(hostKey).catch(() => {})
    }
  })
}

export async function enqueueMessage(item: Omit<QueuedMessage, 'id' | 'state'>) {
  if (!loaded) throw new Error('The offline queue is still opening. Try again.')
  const id =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  await change((items) => [...items, { ...item, id, state: 'queued' }])
  void drain(item.hostKey).catch(() => {})
}

export async function cancelQueuedMessage(id: string) {
  const hostKey = useOfflineQueue.getState().items.find((item) => item.id === id)?.hostKey
  await change((items) => items.filter((item) => item.id !== id || item.state === 'sending'))
  if (hostKey) void drain(hostKey).catch(() => {})
}

export async function pauseQueuedMessage(id: string) {
  let paused = false
  await change((items) =>
    items.map((item) => {
      if (item.id !== id || (item.state !== 'queued' && item.state !== 'review')) return item
      paused = true
      return { ...item, state: 'review' }
    }),
  )
  if (!paused) throw new Error('This message is already being sent')
}

export async function editQueuedMessage(id: string, text: string) {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Enter a message')
  await change((items) =>
    items.map((item) => {
      if (item.id !== id || item.state === 'sending' || item.state === 'uncertain') return item
      const session =
        useHostStore.getState().runtimes[item.hostKey]?.replica.sessions[item.sessionId]
      return { ...item, text: trimmed, turns: session?.turns ?? item.turns, state: 'queued' }
    }),
  )
  const item = useOfflineQueue.getState().items.find((entry) => entry.id === id)
  if (item) void drain(item.hostKey).catch(() => {})
}

async function drain(hostKey: string) {
  if (!loaded) return
  if (draining.has(hostKey)) {
    wakeAgain.add(hostKey)
    return
  }
  draining.add(hostKey)
  try {
    while (true) {
      const runtime = useHostStore.getState().runtimes[hostKey]
      if (runtime?.connection !== 'connected' || !runtime.synced) return
      const item = useOfflineQueue.getState().items.find((entry) => entry.hostKey === hostKey)
      if (!item || item.state !== 'queued') return
      if (needsReview(item, runtime.replica.sessions[item.sessionId]?.turns)) {
        await change((items) =>
          items.map((entry) => (entry.id === item.id ? { ...entry, state: 'review' } : entry)),
        )
        return
      }
      await change((items) =>
        items.map((entry) => (entry === item ? { ...entry, state: 'sending' } : entry)),
      )
      if (
        useOfflineQueue.getState().items.find((entry) => entry.id === item.id)?.state !== 'sending'
      )
        continue
      try {
        await hostRequest(hostKey, 'sessions.prompt', {
          sessionId: item.sessionId,
          text: item.text,
          attachments: item.attachments.length ? item.attachments : undefined,
          mode: item.mode,
          clientMessageId: item.id,
        })
      } catch {
        await change((items) =>
          items.map((entry) => (entry.id === item.id ? { ...entry, state: 'uncertain' } : entry)),
        )
        return
      }
      await change((items) => items.filter((entry) => entry.id !== item.id))
    }
  } finally {
    draining.delete(hostKey)
    if (wakeAgain.delete(hostKey)) void drain(hostKey).catch(() => {})
  }
}
