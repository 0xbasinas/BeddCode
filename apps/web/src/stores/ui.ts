import { create } from 'zustand'

export type PaneId = 'terminal' | 'files' | 'git' | 'browser'
export type GitTab = 'changes' | 'commits' | 'pr'

const PANE_KEY = 'beddcode.right-pane'
const PANES: PaneId[] = ['terminal', 'files', 'git', 'browser']

interface PaneState {
  /** The tool the right pane shows when expanded; kept while it is collapsed. */
  lastPane: PaneId
  /** Collapsed, the right panel is only its icon rail and the thread takes the room. */
  paneCollapsed: boolean
}

interface UiState extends PaneState {
  /** The pane showing now: `lastPane` while expanded, null while collapsed. */
  activePane: PaneId | null
  searchOpen: boolean
  /** The Environment card under the thread's icon; closed at start, kept while the app runs. */
  environmentOpen: boolean
  setEnvironmentOpen(open: boolean): void
  setSearchOpen(open: boolean): void
  /** A rail icon: opens that tool, or collapses the pane when it is the one showing. */
  togglePane(id: PaneId): void
  /** Expands the right pane on this tool. */
  openPane(id: PaneId): void
  /** Hides the pane, leaving the icon rail. */
  collapsePane(): void
  /** Collapses an open pane, or expands a collapsed one on the tool it last showed. */
  togglePaneCollapsed(): void
  /** The tab the Git pane shows; kept here so "Changes" elsewhere can open the pane on it. */
  gitTab: GitTab
  setGitTab(tab: GitTab): void
  /** Opens the Git pane on its Changes tab, whatever the pane showed before. */
  showChanges(): void
  /** Asks the PR tab to open its new pull request form; bumps so each ask is seen once. */
  prCreateAsk: number
  /** Opens the Git pane's PR tab on the form for a new pull request from the current branch. */
  showCreatePr(): void
}

type Store = Pick<Storage, 'getItem' | 'setItem'> | undefined
function storage(): Store {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** The pane's last tool and collapsed state from the previous run; collapsed on first launch. */
export function loadPaneState(store: Store = storage()): PaneState {
  const fallback: PaneState = { lastPane: 'git', paneCollapsed: true }
  try {
    const saved = JSON.parse(store?.getItem(PANE_KEY) ?? 'null') as Partial<PaneState> | null
    if (!saved || typeof saved !== 'object') return fallback
    return {
      lastPane: PANES.includes(saved.lastPane as PaneId) ? (saved.lastPane as PaneId) : 'git',
      paneCollapsed: typeof saved.paneCollapsed === 'boolean' ? saved.paneCollapsed : true,
    }
  } catch {
    return fallback
  }
}

function savePaneState(state: PaneState, store: Store = storage()) {
  try {
    store?.setItem(
      PANE_KEY,
      JSON.stringify({ lastPane: state.lastPane, paneCollapsed: state.paneCollapsed }),
    )
  } catch {
    // Storage full or blocked: the pane starts collapsed next time.
  }
}

/** The pane fields for a new tool/collapsed pair, with `activePane` kept in step. */
function pane(lastPane: PaneId, paneCollapsed: boolean) {
  savePaneState({ lastPane, paneCollapsed })
  return { lastPane, paneCollapsed, activePane: paneCollapsed ? null : lastPane }
}

const initial = loadPaneState()

export const useUiStore = create<UiState>((set) => ({
  ...initial,
  activePane: initial.paneCollapsed ? null : initial.lastPane,
  searchOpen: false,
  environmentOpen: false,
  setEnvironmentOpen: (environmentOpen) => set({ environmentOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  togglePane: (id) => set((s) => pane(id, s.activePane === id)),
  openPane: (id) => set(pane(id, false)),
  collapsePane: () => set((s) => pane(s.lastPane, true)),
  togglePaneCollapsed: () => set((s) => pane(s.lastPane, !s.paneCollapsed)),
  gitTab: 'changes',
  setGitTab: (gitTab) => set({ gitTab }),
  showChanges: () => set({ ...pane('git', false), gitTab: 'changes' }),
  prCreateAsk: 0,
  showCreatePr: () =>
    set((s) => ({ ...pane('git', false), gitTab: 'pr', prCreateAsk: s.prCreateAsk + 1 })),
}))
