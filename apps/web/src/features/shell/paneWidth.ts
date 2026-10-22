/** The right panel's width with no pane open: just the icon rail (`.rail`). */
export const RAIL_WIDTH = '40px'
/** The narrowest an open pane gets (the right panel's `minSize`). */
export const MIN_PANE_WIDTH = 280

const KEY = 'beddcode.right-pane-width'
type Store = Pick<Storage, 'getItem' | 'setItem'> | undefined

/** How wide to open the right panel: as wide as it was last open, else 30% of the window. */
export function openPaneWidth(storage: Store): string | number {
  const saved = Number(storage?.getItem(KEY) ?? NaN)
  return Number.isFinite(saved) && saved >= MIN_PANE_WIDTH ? saved : '30%'
}

/** Remembers an open pane's width for the next time one opens; a collapsed panel is ignored. */
export function rememberPaneWidth(px: number, storage: Store) {
  if (px < MIN_PANE_WIDTH) return
  try {
    storage?.setItem(KEY, String(Math.round(px)))
  } catch {
    // Storage full or blocked: the next open uses the default width.
  }
}
