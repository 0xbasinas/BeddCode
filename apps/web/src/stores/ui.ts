import { create } from 'zustand'

export type PaneId = 'terminal' | 'files' | 'git' | 'browser'

interface UiState {
  activePane: PaneId | null
  searchOpen: boolean
  /** The floating Environment card is folded down to its title bar. */
  environmentMinimized: boolean
  setEnvironmentMinimized(minimized: boolean): void
  setSearchOpen(open: boolean): void
  togglePane(id: PaneId): void
  openPane(id: PaneId): void
}

const MINIMIZED_KEY = 'beddcode.environment-minimized'

function readMinimized(): boolean {
  try {
    return globalThis.localStorage?.getItem(MINIMIZED_KEY) === '1'
  } catch {
    return false
  }
}

function writeMinimized(value: boolean) {
  try {
    globalThis.localStorage?.setItem(MINIMIZED_KEY, value ? '1' : '0')
  } catch {
    // It just opens expanded next time.
  }
}

export const useUiStore = create<UiState>((set) => ({
  activePane: null,
  searchOpen: false,
  environmentMinimized: readMinimized(),
  setEnvironmentMinimized: (environmentMinimized) => {
    writeMinimized(environmentMinimized)
    set({ environmentMinimized })
  },
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  togglePane: (id) => set((s) => ({ activePane: s.activePane === id ? null : id })),
  openPane: (id) => set({ activePane: id }),
}))
