import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

interface Prefs {
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
      openDone: [],
      collapsed: [],
      toggleDone: (key) => set((s) => ({ openDone: flip(s.openDone, key) })),
      toggleCollapsed: (key) => set((s) => ({ collapsed: flip(s.collapsed, key) })),
    }),
    { name: 'beddcode.prefs', storage: createJSONStorage(() => AsyncStorage) },
  ),
)
