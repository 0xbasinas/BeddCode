export interface Offset {
  /** Distance from the container's right edge, in px. */
  right: number
  /** Distance from the container's top edge, in px. */
  top: number
  /**
   * The side the card was dropped on. A drag snaps it to the nearer edge, so a resize keeps it
   * hugging that edge instead of drifting into the middle of the conversation.
   */
  side?: 'left' | 'right'
}

export interface Size {
  width: number
  height: number
}

/** Where the card starts: tucked into the top right, just below the thread header. */
export const DEFAULT_OFFSET: Offset = { right: 16, top: 76 }

const MARGIN = 8
/** How far a snapped card sits from the edge it hugs. */
export const EDGE = DEFAULT_OFFSET.right

/**
 * Keeps a floating card fully inside its container, however it was dragged or however much the
 * window shrank. A card larger than the container is pinned to its top-right corner. A card that
 * was snapped to the left edge stays on it whatever the width.
 */
export function clampOffset(offset: Offset, container: Size, card: Size): Offset {
  const maxRight = Math.max(MARGIN, container.width - card.width - MARGIN)
  const maxTop = Math.max(MARGIN, container.height - card.height - MARGIN)
  const right = offset.side === 'left' ? container.width - card.width - EDGE : offset.right
  const next: Offset = {
    right: Math.min(Math.max(MARGIN, right), maxRight),
    top: Math.min(Math.max(MARGIN, offset.top), maxTop),
  }
  if (offset.side) next.side = offset.side
  return next
}

/**
 * Where a dropped card settles: against whichever side edge its middle is nearer, at the height
 * it was dropped. A card left floating mid-thread would split the conversation in two; snapped,
 * the conversation can always move to the other side of it.
 */
export function snapOffset(offset: Offset, container: Size, card: Size): Offset {
  const center = container.width - offset.right - card.width / 2
  const side = center < container.width / 2 ? 'left' : 'right'
  return clampOffset(
    { right: side === 'right' ? EDGE : container.width - card.width - EDGE, top: offset.top, side },
    container,
    card,
  )
}

const KEY = 'beddcode.environment-card'

/** The last place the user left the card; nothing saved (or unreadable) means the default. */
export function loadOffset(storage: Pick<Storage, 'getItem'> | undefined): Offset {
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return DEFAULT_OFFSET
    const parsed = JSON.parse(raw) as Partial<Offset>
    if (typeof parsed.right !== 'number' || typeof parsed.top !== 'number') return DEFAULT_OFFSET
    const offset: Offset = { right: parsed.right, top: parsed.top }
    if (parsed.side === 'left' || parsed.side === 'right') offset.side = parsed.side
    return offset
  } catch {
    return DEFAULT_OFFSET
  }
}

export function saveOffset(storage: Pick<Storage, 'setItem'> | undefined, offset: Offset) {
  try {
    storage?.setItem(KEY, JSON.stringify(offset))
  } catch {
    // The card just starts in its default place next time.
  }
}

export interface Column {
  /** The scroller's own left/right padding, in px. */
  padding: number
  /** The widest the centered conversation column gets, in px. */
  maxWidth: number
}

/** Space kept between the conversation and the card. */
const GAP = 12
/**
 * The conversation never gets narrower than this to make room. A thread too narrow to keep this
 * much beside the card docks the card above the conversation instead (see `shouldDock`).
 */
export const MIN_COLUMN = 360
/** The expanded card's width (`.env-card` in app.css). */
export const CARD_WIDTH = 300

/**
 * Whether the thread is too narrow for the card to float beside a readable conversation column:
 * the card plus its edge distance and gap, and MIN_COLUMN between the thread's own padding. Judged
 * on the expanded card's width so that minimizing or expanding never flips the decision.
 */
export function shouldDock(width: number, column: Column, cardWidth = CARD_WIDTH): boolean {
  return width - 2 * column.padding - (cardWidth + EDGE + GAP) < MIN_COLUMN
}

export interface Reserve {
  left: number
  right: number
}

/**
 * The least extra padding on one side of the centered column that keeps its other edge at least
 * `distance` px away from the other side of the thread.
 */
function reserveFrom(width: number, distance: number, column: Column): number {
  const limit = width - distance
  const edge = (reserve: number) =>
    (width - reserve + Math.min(column.maxWidth, width - 2 * column.padding - reserve)) / 2
  if (edge(0) <= limit + 0.5) return 0
  // Shifting the full-width column over is enough while it keeps its full width…
  const shift = Math.ceil(width + column.maxWidth - 2 * limit)
  if (column.maxWidth <= width - 2 * column.padding - shift) return shift
  // …otherwise it ends right where the card begins.
  return Math.ceil(width - column.padding - limit)
}

/**
 * How much extra room to keep free beside the conversation so the floating card does not cover
 * its lines. The column is centered, so on a wide thread it simply fits next to the card; otherwise
 * it moves away from the card (to whichever side costs less), then narrows, but never below
 * MIN_COLUMN. Threads that narrow are docked instead (`shouldDock`), so the cap is only a guard.
 */
export function cardReserve(width: number, offset: Offset, card: Size, column: Column): Reserve {
  const cardLeft = width - offset.right - card.width
  const cardRight = width - offset.right
  const inner = Math.min(column.maxWidth, width - 2 * column.padding)
  const columnLeft = (width - inner) / 2
  const columnRight = columnLeft + inner
  if (columnRight <= cardLeft - GAP + 0.5 || columnLeft >= cardRight + GAP - 0.5) {
    return { left: 0, right: 0 }
  }
  const most = Math.max(0, width - 2 * column.padding - MIN_COLUMN)
  // Column to the left of the card: room on the right, and the mirror case.
  const right = reserveFrom(width, offset.right + card.width + GAP, column)
  const left = reserveFrom(width, cardRight + GAP, column)
  const fitsRight = right <= most
  const fitsLeft = left <= most
  if (fitsRight && (!fitsLeft || right <= left)) return { left: 0, right }
  if (fitsLeft) return { left, right: 0 }
  return { left: 0, right: Math.min(right, most) }
}
