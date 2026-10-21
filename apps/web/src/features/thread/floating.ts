export interface Offset {
  /** Distance from the container's right edge, in px. */
  right: number
  /** Distance from the container's top edge, in px. */
  top: number
}

export interface Size {
  width: number
  height: number
}

/** Where the card starts: tucked into the top right, just below the thread header. */
export const DEFAULT_OFFSET: Offset = { right: 16, top: 76 }

const MARGIN = 8

/**
 * Keeps a floating card fully inside its container, however it was dragged or however much the
 * window shrank. A card larger than the container is pinned to its top-right corner.
 */
export function clampOffset(offset: Offset, container: Size, card: Size): Offset {
  const maxRight = Math.max(MARGIN, container.width - card.width - MARGIN)
  const maxTop = Math.max(MARGIN, container.height - card.height - MARGIN)
  return {
    right: Math.min(Math.max(MARGIN, offset.right), maxRight),
    top: Math.min(Math.max(MARGIN, offset.top), maxTop),
  }
}

const KEY = 'beddcode.environment-card'

/** The last place the user left the card; nothing saved (or unreadable) means the default. */
export function loadOffset(storage: Pick<Storage, 'getItem'> | undefined): Offset {
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return DEFAULT_OFFSET
    const parsed = JSON.parse(raw) as Partial<Offset>
    return typeof parsed.right === 'number' && typeof parsed.top === 'number'
      ? { right: parsed.right, top: parsed.top }
      : DEFAULT_OFFSET
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
