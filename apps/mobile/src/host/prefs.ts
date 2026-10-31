import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type SessionSort = 'recent' | 'created' | 'status' | 'name'

export const SESSION_SORTS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Recent activity' },
  { value: 'created', label: 'Created' },
  { value: 'status', label: 'Status' },
  { value: 'name', label: 'Name' },
]

interface Prefs {
  /** The session sort chosen for each host (`all` for every host). */
  sorts: Record<string, SessionSort>
  setSort(hostKey: string, sort: SessionSort): void
  /** Folders whose Done section the user opened (`<host>\n<path>`). */
  openDone: string[]
  /** Folders the user folded away. */
  collapsed: string[]
  toggleDone(key: string): void
  toggleCollapsed(key: string): void
}

const flip = (list: string[], key: string) =>
  list.includes(key) ? list.filter((k) => k !== key) : [...list, key]

/** Small view choices that survive a restart. */
export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      sorts: {},
      setSort: (hostKey, sort) => set((s) => ({ sorts: { ...s.sorts, [hostKey]: sort } })),
      openDone: [],
      collapsed: [],
      toggleDone: (key) => set((s) => ({ openDone: flip(s.openDone, key) })),
      toggleCollapsed: (key) => set((s) => ({ collapsed: flip(s.collapsed, key) })),
    }),
    { name: 'beddcode.prefs', storage: createJSONStorage(() => AsyncStorage) },
  ),
)
