import { create } from 'zustand'

export type PaneId = 'terminal' | 'files' | 'git' | 'browser'

interface UiState {
  activePane: PaneId | null
  togglePane(id: PaneId): void
}

export const useUiStore = create<UiState>((set) => ({
  activePane: null,
  togglePane: (id) => set((s) => ({ activePane: s.activePane === id ? null : id })),
}))
