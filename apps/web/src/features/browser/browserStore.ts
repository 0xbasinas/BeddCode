import { create } from 'zustand'
import { tabLabel } from '@beddcode/client-runtime'
import type { BrowserCommand, BrowserEvent, BrowserPageState } from '@beddcode/contracts'
import '../../ui/desktop.ts'

export interface BrowserTab {
  id: number
  url: string
  title: string
  favicon?: string
  /** The page is a port on a remote host forwarded here: which host, and its port there. */
  via?: { host: string; port: number }
  /** An agent drives this tab (browser use): whose session, and how to show it. */
  agent?: BrowserTabAgent
}

export interface BrowserTabAgent {
  hostKey: string
  sessionId: string
  /** "Claude Code", "Codex"… */
  label: string
  sessionTitle?: string
  /** The page is a forwarded remote port: the local port it is reached at here. */
  localPort?: number
}

/** The key an agent session's browser state is kept under. */
export const agentKey = (hostKey: string, sessionId: string) => `${hostKey}|${sessionId}`

/** A question a page asked that waits for the user. */
export type BrowserPrompt =
  Extract<BrowserEvent, { type: 'permission' }> | Extract<BrowserEvent, { type: 'login' }>

export type BrowserDownload = Extract<BrowserEvent, { type: 'download' }>

/** Bumped when a page asks for one of the pane's own actions (Ctrl+F, Ctrl+L inside a page). */
export interface BrowserRequests {
  find: number
  address: number
}

interface BrowserState {
  tabs: BrowserTab[]
  active: number | null
  /** What each tab's page last reported (desktop app only). */
  pages: Record<number, Partial<BrowserPageState>>
  prompts: BrowserPrompt[]
  downloads: BrowserDownload[]
  requests: BrowserRequests
  /** Agent sessions whose browser use the user paused (took over, or stopped), by agentKey. */
  paused: Record<string, true>
  /** Each agent session's current tab, by agentKey. */
  agentTab: Record<string, number>
  /** Something to tell an agent with its next answer (a page opened a tab), by agentKey. */
  agentNotes: Record<string, string>
  /** Opens a page; returns its tab. `background` leaves the shown tab as it is. */
  open(
    url: string,
    options?: {
      newTab?: boolean
      via?: BrowserTab['via']
      background?: boolean
      agent?: BrowserTabAgent
    },
  ): number
  close(id: number): void
  activate(id: number): void
  /** The page navigated on its own (a link, a redirect): keep the address bar in step. */
  navigated(id: number, url: string): void
  titled(id: number, title: string): void
  faviconed(id: number, favicon: string): void
  dismissDownload(id: string): void
}

let nextId = 1

/** The desktop app's native pages, absent in a plain browser. */
export const nativeBrowser = () =>
  typeof window === 'undefined' ? undefined : window.beddcodeDesktop?.browser

/** Runs a command on the desktop app's pages; resolves to undefined in a plain browser. */
export function browserCommand<T = unknown>(command: BrowserCommand): Promise<T | undefined> {
  const native = nativeBrowser()
  if (!native) return Promise.resolve(undefined)
  return native.command(command).then(
    (value) => value as T,
    () => undefined,
  )
}

const load = (id: number, url: string, op: 'ensure' | 'navigate') => {
  if (url !== 'about:blank') void browserCommand({ op, tabId: id, url })
}

export const useBrowser = create<BrowserState>((set, get) => ({
  tabs: [],
  active: null,
  pages: {},
  prompts: [],
  downloads: [],
  requests: { find: 0, address: 0 },
  paused: {},
  agentTab: {},
  agentNotes: {},

  open(url, options) {
    const { tabs, active } = get()
    const current = tabs.find((t) => t.id === active)
    if (current && !options?.newTab && !options?.agent) {
      set({
        tabs: tabs.map((t) =>
          t.id === current.id ? { ...t, url, title: tabLabel(url), via: options?.via } : t,
        ),
      })
      load(current.id, url, 'navigate')
      return current.id
    }
    const tab: BrowserTab = {
      id: nextId++,
      url,
      title: tabLabel(url),
      via: options?.via,
      agent: options?.agent,
    }
    set({
      tabs: [...tabs, tab],
      active: options?.background && active !== null ? active : tab.id,
    })
    load(tab.id, url, 'ensure')
    return tab.id
  },

  close(id) {
    void browserCommand({ op: 'close', tabId: id })
    set(({ tabs, active, pages, prompts }) => {
      const index = tabs.findIndex((t) => t.id === id)
      const next = tabs.filter((t) => t.id !== id)
      const { [id]: _gone, ...rest } = pages
      return {
        tabs: next,
        agentTab: Object.fromEntries(
          Object.entries(useBrowser.getState().agentTab).filter(([, tab]) => tab !== id),
        ),
        pages: rest,
        prompts: prompts.filter((p) => p.tabId !== id),
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

  faviconed(id, favicon) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, favicon } : t)) }))
  },

  dismissDownload(id) {
    set((s) => ({ downloads: s.downloads.filter((d) => d.id !== id) }))
  },
}))

/** Folds one event from the desktop app's pages into the store. */
export function applyBrowserEvent(event: BrowserEvent): void {
  const store = useBrowser
  switch (event.type) {
    case 'state': {
      const { tabId, state } = event
      if (!store.getState().tabs.some((t) => t.id === tabId)) return
      store.setState((s) => ({ pages: { ...s.pages, [tabId]: { ...s.pages[tabId], ...state } } }))
      const { navigated, titled, faviconed } = store.getState()
      if (state.url) navigated(tabId, state.url)
      if (state.title) titled(tabId, state.title)
      if (state.favicon !== undefined) faviconed(tabId, state.favicon)
      return
    }
    case 'open': {
      // A page an agent drives opens its links in another tab of the agent's, out of the way.
      const from = store.getState().tabs.find((t) => t.id === event.tabId)
      if (from?.agent) {
        const key = agentKey(from.agent.hostKey, from.agent.sessionId)
        const id = store
          .getState()
          .open(event.url, { newTab: true, background: true, agent: from.agent })
        void browserCommand({ op: 'agent-control', tabId: id, agent: from.agent.label })
        store.setState((s) => ({
          agentTab: { ...s.agentTab, [key]: id },
          agentNotes: {
            ...s.agentNotes,
            [key]: `The page opened ${event.url} in a new tab (Tab ${id}), which is now your current tab.`,
          },
        }))
        return
      }
      store.getState().open(event.url, { newTab: true })
      return
    }
    case 'user-input': {
      const tab = store.getState().tabs.find((t) => t.id === event.tabId)
      if (tab?.agent) pauseAgent(tab.agent.hostKey, tab.agent.sessionId)
      return
    }
    case 'shortcut': {
      const { open, close, requests } = store.getState()
      if (event.action === 'new-tab') open('about:blank', { newTab: true })
      else if (event.action === 'close-tab') close(event.tabId)
      else if (event.action === 'find')
        store.setState({ requests: { ...requests, find: requests.find + 1 } })
      else store.setState({ requests: { ...requests, address: requests.address + 1 } })
      return
    }
    case 'permission':
    case 'login':
      store.setState((s) => ({ prompts: [...s.prompts.filter((p) => p.id !== event.id), event] }))
      return
    case 'permission-done':
    case 'login-done':
      store.setState((s) => ({ prompts: s.prompts.filter((p) => p.id !== event.id) }))
      return
    case 'download':
      store.setState((s) => ({
        downloads: [...s.downloads.filter((d) => d.id !== event.id), event].slice(-3),
      }))
      return
  }
}

/** Stops an agent session's browser use until resumeAgent (the user took over). */
export function pauseAgent(hostKey: string, sessionId: string) {
  const key = agentKey(hostKey, sessionId)
  useBrowser.setState((s) => (s.paused[key] ? s : { paused: { ...s.paused, [key]: true } }))
}

export function resumeAgent(hostKey: string, sessionId: string) {
  const key = agentKey(hostKey, sessionId)
  useBrowser.setState((s) => {
    const { [key]: _gone, ...paused } = s.paused
    return { paused }
  })
}

// One subscription for the app's lifetime: pages keep reporting while the pane is closed.
nativeBrowser()?.onEvent(applyBrowserEvent)
