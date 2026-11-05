/**
 * Selection set, pick filters, and hit ranking. Pure helpers: the viewport
 * feeds in raycast results and screen positions, this module decides what wins.
 */

export type PickKind = 'face' | 'edge' | 'vertex'

export const PICK_KINDS: readonly PickKind[] = ['face', 'edge', 'vertex']

/** Screen-space distance (px) an edge or vertex may be from the cursor and still count. */
export const EDGE_PICK_PX = 6
export const VERTEX_PICK_PX = 8

export interface SelectionItem {
  kind: PickKind
  featureId: string
  /** faceId / edgeId from the mesh groups, or a vertex ordinal. */
  id: number
}

export interface HitCandidate extends SelectionItem {
  /** Distance along the ray, used to break ties inside one kind. */
  depth: number
  /** Cursor distance in screen pixels. Faces can leave this at 0. */
  screenPx: number
}

export function selectionKey(item: SelectionItem): string {
  return `${item.featureId}:${item.kind}:${item.id}`
}

export function sameItem(a: SelectionItem, b: SelectionItem): boolean {
  return selectionKey(a) === selectionKey(b)
}

function threshold(kind: PickKind, edgePx: number, vertexPx: number): number {
  if (kind === 'edge') return edgePx
  if (kind === 'vertex') return vertexPx
  return Number.POSITIVE_INFINITY
}

/**
 * Best hit for the active filter. The filtered kind always wins; other kinds
 * are ignored so a Face filter never returns an edge. Edges and vertices must
 * be inside their pixel threshold. Ties go to the nearer screen distance, then
 * the nearer depth, then the lower id so results stay stable.
 */
export function rankedHits<T extends HitCandidate>(
  candidates: readonly T[],
  filter: PickKind,
  edgePx = EDGE_PICK_PX,
  vertexPx = VERTEX_PICK_PX,
): T[] {
  const sorted = candidates
    .filter((hit) => hit.kind === filter && hit.screenPx <= threshold(hit.kind, edgePx, vertexPx))
    .slice()
    .sort(compareHits)
  const seen = new Set<string>()
  return sorted.filter((hit) => {
    const key = selectionKey(hit)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function rankHits(
  candidates: readonly HitCandidate[],
  filter: PickKind,
  edgePx = EDGE_PICK_PX,
  vertexPx = VERTEX_PICK_PX,
): HitCandidate | null {
  return rankedHits(candidates, filter, edgePx, vertexPx)[0] ?? null
}

function compareHits(a: HitCandidate, b: HitCandidate): number {
  if (a.kind !== 'face' && a.screenPx !== b.screenPx) return a.screenPx - b.screenPx
  if (a.depth !== b.depth) return a.depth - b.depth
  return a.id - b.id
}

/** Plain click replaces the set; additive (shift) click toggles the item. */
export function toggleSelection(
  current: readonly SelectionItem[],
  item: SelectionItem | null,
  additive: boolean,
): SelectionItem[] {
  if (!item) return additive ? [...current] : []
  if (!additive) return [item]
  const exists = current.some((entry) => sameItem(entry, item))
  return exists ? current.filter((entry) => !sameItem(entry, item)) : [...current, item]
}

/** Drops items whose kind is no longer allowed by the filter. */
export function keepKind(current: readonly SelectionItem[], filter: PickKind): SelectionItem[] {
  return current.filter((item) => item.kind === filter)
}

export interface ScreenRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function normalizeRect(rect: ScreenRect): ScreenRect {
  return {
    x0: Math.min(rect.x0, rect.x1),
    y0: Math.min(rect.y0, rect.y1),
    x1: Math.max(rect.x0, rect.x1),
    y1: Math.max(rect.y0, rect.y1),
  }
}

export function inRect(x: number, y: number, rect: ScreenRect): boolean {
  const box = normalizeRect(rect)
  return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1
}

export interface CenterItem extends SelectionItem {
  /** Projected screen position of the face / edge / vertex center. */
  x: number
  y: number
}

/** Items of the filtered kind whose projected center lies inside the rect. */
export function boxSelect(
  centers: readonly CenterItem[],
  rect: ScreenRect,
  filter: PickKind,
): SelectionItem[] {
  const out: SelectionItem[] = []
  for (const item of centers) {
    if (item.kind !== filter || !inRect(item.x, item.y, rect)) continue
    out.push({ kind: item.kind, featureId: item.featureId, id: item.id })
  }
  return out
}

/** Merge for additive box select, without duplicates. */
export function mergeSelection(
  current: readonly SelectionItem[],
  added: readonly SelectionItem[],
): SelectionItem[] {
  const out = [...current]
  for (const item of added) if (!out.some((entry) => sameItem(entry, item))) out.push(item)
  return out
}

/** Distance in px from point (px, py) to the segment a-b. */
export function segmentDistancePx(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
