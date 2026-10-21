import { create } from 'zustand'
import { tabLabel } from './url.ts'

export interface BrowserTab {
  id: number
  url: string
  title: string
}

interface BrowserState {
  tabs: BrowserTab[]
  active: number | null
  open(url: string, options?: { newTab?: boolean }): void
  close(id: number): void
  activate(id: number): void
  /** The page navigated on its own (a link, a redirect): keep the address bar in step. */
  navigated(id: number, url: string): void
  titled(id: number, title: string): void
}

let nextId = 1

export const useBrowser = create<BrowserState>((set, get) => ({
  tabs: [],
  active: null,

  open(url, options) {
    const { tabs, active } = get()
    const current = tabs.find((t) => t.id === active)
    if (current && !options?.newTab) {
      set({
        tabs: tabs.map((t) => (t.id === current.id ? { ...t, url, title: tabLabel(url) } : t)),
      })
      return
    }
    const tab = { id: nextId++, url, title: tabLabel(url) }
    set({ tabs: [...tabs, tab], active: tab.id })
  },

  close(id) {
    set(({ tabs, active }) => {
      const index = tabs.findIndex((t) => t.id === id)
      const next = tabs.filter((t) => t.id !== id)
      return {
        tabs: next,
        active: active === id ? (next[index]?.id ?? next[index - 1]?.id ?? null) : active,
      }
    })
  },

  activate(id) {
    set({ active: id })
  },

  navigated(id, url) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, url } : t)) }))
  },

  titled(id, title) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && title ? { ...t, title } : t)) }))
  },
}))
