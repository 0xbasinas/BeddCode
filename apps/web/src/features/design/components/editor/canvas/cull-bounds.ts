export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Extra room kept on each side of the viewport, as a share of its size. */
const MARGIN = 0.25
/** How close to the edge of the kept area the viewport may come before it is replaced. */
const EDGE = 0.05

/**
 * The area elements are culled against. Culling against the exact viewport hands every element a
 * new `viewportBounds` on every pan or zoom step, so none of them can skip rendering. This keeps
 * the previous (padded) area while the viewport stays well inside it, and returns that very object
 * so a memoized element sees equal props; once the viewport nears the edge, or the zoom changes
 * enough to make the area the wrong size, it returns a fresh padded one.
 */
export function nextCullBounds(viewport: Bounds, prev: Bounds): Bounds {
  const w = viewport.maxX - viewport.minX
  const h = viewport.maxY - viewport.minY
  const prevW = prev.maxX - prev.minX
  const inside =
    viewport.minX >= prev.minX + w * EDGE &&
    viewport.maxX <= prev.maxX - w * EDGE &&
    viewport.minY >= prev.minY + h * EDGE &&
    viewport.maxY <= prev.maxY - h * EDGE &&
    // A zoom change makes the kept area the wrong size (it is about 1.5 viewports wide).
    prevW < w * 2.2 &&
    prevW > w * 1.3
  if (inside) return prev
  return {
    minX: viewport.minX - w * MARGIN,
    maxX: viewport.maxX + w * MARGIN,
    minY: viewport.minY - h * MARGIN,
    maxY: viewport.maxY + h * MARGIN,
  }
}
