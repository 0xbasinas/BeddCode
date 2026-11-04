import { describe, expect, it } from 'vitest'
import { createCursorStore } from './cursorStore.ts'

describe('cursor storage adapter', () => {
  it('isolates hosts, supports async storage, and keeps the latest 200 sessions', async () => {
    const data = new Map<string, string>()
    const store = createCursorStore({
      getItem: async (key) => data.get(key) ?? null,
      setItem: async (key, value) => {
        data.set(key, value)
      },
    })
    const sessions = Object.fromEntries(
      Array.from({ length: 205 }, (_, i) => [`s${i}`, { sessionSeq: i + 1, seq: i + 1 }]),
    )
    await store.save('host/a', { logId: 'log', sessions })
    const saved = await store.load('host/a')
    expect(Object.keys(saved!.sessions)).toHaveLength(200)
    expect(saved!.sessions.s0).toBeUndefined()
    expect(saved!.sessions.s204).toEqual({ sessionSeq: 205, seq: 205 })
    expect(await store.load('host/b')).toBeNull()
  })
  it('ignores corrupt and unavailable storage', async () => {
    expect(await createCursorStore({ getItem: () => '{', setItem: () => {} }).load('h')).toBeNull()
    const store = createCursorStore({
      getItem: () => {
        throw Error()
      },
      setItem: () => {
        throw Error()
      },
    })
    expect(await store.load('h')).toBeNull()
    await expect(store.save('h', { sessions: {} })).resolves.toBeUndefined()
  })
})
