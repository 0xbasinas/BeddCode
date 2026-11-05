/** The right panel's width with no pane open: just the icon rail (`.rail`). */
export const RAIL_WIDTH = '40px'
/** The narrowest an open pane gets (the right panel's `minSize`). */
export const MIN_PANE_WIDTH = 280
/** CAD asks for at least this many pixels, and at most this many when it is not maximized. */
export const CAD_PANE_MIN = 1100
export const CAD_PANE_MAX = 1400
/** Sidebar and gutters left beside a maximized CAD pane (matches the CSS width). */
const CAD_CHROME = 280 + 24

const KEY = 'beddcode.right-pane-width'
type Store = Pick<Storage, 'getItem' | 'setItem'> | undefined

/** How wide to open the right panel: as wide as it was last open, else 30% of the window. */
export function openPaneWidth(storage: Store): string | number {
  const saved = Number(storage?.getItem(KEY) ?? NaN)
  return Number.isFinite(saved) && saved >= MIN_PANE_WIDTH ? saved : '30%'
}

/**
 * How wide the CAD pane asks to be. Open CAD wants about 70% of the window, between 1100 and 1400.
 * Maximized CAD wants the window minus the sidebar and gutters, and at least 1100.
 */
export function cadWantWidth(windowWidth: number, maximized: boolean): number {
  const viewport = Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 1440
  if (maximized) return Math.max(CAD_PANE_MIN, Math.round(viewport - CAD_CHROME))
  return Math.min(CAD_PANE_MAX, Math.max(CAD_PANE_MIN, Math.round(viewport * 0.7)))
}

/**
 * True when a link asks for the CAD pane (`?cad=1` or `#cad`). Playwright uses this once.
 * Skip the first-run wizard with `localStorage.setItem('beddcode.setup-skipped', '1')`
 * (`skipSetup` in features/newsession/Welcome.tsx). Leave Welcome in place.
 */
export function urlAsksForCad(search: string, hash: string): boolean {
  const query = new URLSearchParams(search.replace(/^\?/, ''))
  if (query.get('cad') === '1') return true
  const bare = hash.replace(/^#/, '')
  if (bare === 'cad' || bare === 'cad=1') return true
  return new URLSearchParams(bare.replace(/^\?/, '')).get('cad') === '1'
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
