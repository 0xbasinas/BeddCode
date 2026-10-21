import { create } from 'zustand'

export type PaneId = 'terminal' | 'files' | 'git' | 'browser'

interface UiState {
  activePane: PaneId | null
  searchOpen: boolean
  setSearchOpen(open: boolean): void
  togglePane(id: PaneId): void
  openPane(id: PaneId): void
}

export const useUiStore = create<UiState>((set) => ({
  activePane: null,
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  togglePane: (id) => set((s) => ({ activePane: s.activePane === id ? null : id })),
  openPane: (id) => set({ activePane: id }),
}))
