import { create } from 'zustand'

/** The data type a session row carries while it is dragged; its value is the session id. */
export const SESSION_DRAG = 'application/x-beddcode-session'

/** At most this many sessions side by side; each needs room for a readable transcript. */
export const MAX_PANES = 3

/** Where a dragged session lands: in place of the pane at `index`, or on its left or right. */
export interface DropTarget {
  index: number
  edge: 'left' | 'right' | 'center'
}

/**
 * The sessions shown after a drop, left to right. `panes` is what shows now (the first one is the
 * session the window is on). Dropping on a pane's middle shows the session there instead; on an
 * edge, it opens beside that pane. A session already showing moves rather than showing twice, and
 * when the panes are full the one furthest from the drop makes room.
 */
export function placeSession(panes: string[], sessionId: string, target: DropTarget): string[] {
  const at = Math.max(0, Math.min(target.index, panes.length - 1))
  const anchor = panes[at]
  if (anchor === sessionId) return panes
  const rest = panes.filter((id) => id !== sessionId)
  let index = anchor === undefined ? 0 : rest.indexOf(anchor)
  if (index < 0) index = 0
  if (target.edge === 'center' && anchor !== undefined) {
    return rest.map((id, i) => (i === index ? sessionId : id))
  }
  const insertAt = target.edge === 'right' ? index + 1 : index
  const next = [...rest.slice(0, insertAt), sessionId, ...rest.slice(insertAt)]
  if (next.length <= MAX_PANES) return next
  // Drop the pane furthest from the new one.
  const drop = insertAt >= next.length / 2 ? 0 : next.length - 1
  return next.filter((_, i) => i !== drop)
}

/** Which part of a pane the pointer is over: its outer quarters split, the middle replaces. */
export function dropEdge(x: number, left: number, width: number): DropTarget['edge'] {
  if (width <= 0) return 'center'
  const at = (x - left) / width
  if (at < 0.25) return 'left'
  if (at > 0.75) return 'right'
  return 'center'
}

const STORE_KEY = 'beddcode.split'

type Store = Pick<Storage, 'getItem' | 'setItem'> | undefined
function storage(): Store {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** The sessions open beside the main one from the last run; nothing when unreadable. */
export function loadSide(store: Store = storage()): string[] {
  try {
    const saved = JSON.parse(store?.getItem(STORE_KEY) ?? 'null') as unknown
    if (!Array.isArray(saved)) return []
    return [
      ...new Set(saved.filter((id): id is string => typeof id === 'string' && id !== '')),
    ].slice(0, MAX_PANES - 1)
  } catch {
    return []
  }
}

function saveSide(side: string[], store: Store = storage()) {
  try {
    store?.setItem(STORE_KEY, JSON.stringify(side))
  } catch {
    // Storage full or blocked: the split is not restored next time.
  }
}

interface SplitState {
  /** Sessions shown beside the main one (the one in the address), left to right. */
  side: string[]
  /** The pane last clicked or typed in; keyboard shortcuts for a session act on it. */
  focused: string | undefined
  setSide(side: string[]): void
  setFocused(sessionId: string): void
  /** Takes a session out of the side panes. */
  closeSide(sessionId: string): void
}

export const useSplit = create<SplitState>((set) => ({
  side: loadSide(),
  focused: undefined,
  setSide: (side) => {
    const clean = [...new Set(side)].slice(0, MAX_PANES - 1)
    saveSide(clean)
    set({ side: clean })
  },
  setFocused: (focused) => set({ focused }),
  closeSide: (sessionId) =>
    set((s) => {
      const side = s.side.filter((id) => id !== sessionId)
      saveSide(side)
      return { side }
    }),
}))
