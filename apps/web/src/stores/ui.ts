import { create } from 'zustand'

export type PaneId = 'terminal' | 'files' | 'git' | 'browser'
export type GitTab = 'changes' | 'commits' | 'pr'

interface UiState {
  activePane: PaneId | null
  searchOpen: boolean
  /** The Environment card under the thread's icon; closed at start, kept while the app runs. */
  environmentOpen: boolean
  setEnvironmentOpen(open: boolean): void
  setSearchOpen(open: boolean): void
  togglePane(id: PaneId): void
  openPane(id: PaneId): void
  /** The tab the Git pane shows; kept here so "Changes" elsewhere can open the pane on it. */
  gitTab: GitTab
  setGitTab(tab: GitTab): void
  /** Opens the Git pane on its Changes tab, whatever the pane showed before. */
  showChanges(): void
}

export const useUiStore = create<UiState>((set) => ({
  activePane: null,
  searchOpen: false,
  environmentOpen: false,
  setEnvironmentOpen: (environmentOpen) => set({ environmentOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  togglePane: (id) => set((s) => ({ activePane: s.activePane === id ? null : id })),
  openPane: (id) => set({ activePane: id }),
  gitTab: 'changes',
  setGitTab: (gitTab) => set({ gitTab }),
  showChanges: () => set({ activePane: 'git', gitTab: 'changes' }),
}))
