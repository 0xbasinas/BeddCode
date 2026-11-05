import type { SketchEntity } from './types.ts'
import { snapPoint } from './project.ts'

/** What won the snap. Endpoint beats midpoint, then axis, then the grid. */
export type SnapKind = 'endpoint' | 'midpoint' | 'axis' | 'grid'

export interface SnapQuery {
  cursor: readonly [number, number]
  /** Sketch millimetres. Anything farther is ignored. */
  tolerance: number
  gridStep: number
  /** Last accepted point. Horizontal and vertical locks run through it. */
  anchor?: readonly [number, number] | null
  entities?: readonly SketchEntity[]
}

export interface SnapChoice {
  point: [number, number]
  kind: SnapKind
}

const EPS = 1e-6

/**
 * World size of a snap grab at this camera distance.
 * It grows with distance so a point stays easy to hit after orbiting out,
 * and shrinks when the camera is close so the grid can still win.
 */
export function sketchSnapTolerance(distance: number): number {
  if (!(distance > 0) || !Number.isFinite(distance)) return 0.8
  return Math.min(8, Math.max(0.15, distance * 0.006))
}

/** Shift swaps the 1 mm step with the 5 mm step. Any other base becomes 5 mm. */
export function gridStepForShift(base: number, shiftKey: boolean): number {
  const step = base > 0 && Number.isFinite(base) ? base : 1
  if (!shiftKey) return step
  return step === 5 ? 1 : 5
}

export function snapCaption(kind: SnapKind): string {
  if (kind === 'endpoint') return 'end'
  if (kind === 'midpoint') return 'mid'
  if (kind === 'axis') return 'axis'
  return 'grid'
}

/**
 * First match wins: endpoint, midpoint, horizontal or vertical from the
 * anchor, then the grid. The anchor itself counts as an endpoint.
 */
export function resolveSnap(query: SnapQuery): SnapChoice {
  const tolerance = query.tolerance > 0 ? query.tolerance : 0
  const endpoints = featurePoints(query.entities ?? [], 'endpoint')
  if (query.anchor) endpoints.push([query.anchor[0], query.anchor[1]])
  const end = nearest(endpoints, query.cursor, tolerance)
  if (end) return { point: end, kind: 'endpoint' }
  const mid = nearest(featurePoints(query.entities ?? [], 'midpoint'), query.cursor, tolerance)
  if (mid) return { point: mid, kind: 'midpoint' }
  const axis = axisLock(query.anchor, query.cursor, tolerance)
  if (axis) return { point: axis, kind: 'axis' }
  const step = query.gridStep > 0 && Number.isFinite(query.gridStep) ? query.gridStep : 1
  return { point: snapPoint(query.cursor, step), kind: 'grid' }
}

function nearest(
  points: readonly (readonly [number, number])[],
  cursor: readonly [number, number],
  tolerance: number,
): [number, number] | null {
  if (!(tolerance > 0)) return null
  let best: [number, number] | null = null
  let bestDist = Infinity
  for (const point of points) {
    const dist = Math.hypot(point[0] - cursor[0], point[1] - cursor[1])
    if (dist <= tolerance && dist < bestDist) {
      best = [point[0], point[1]]
      bestDist = dist
    }
  }
  return best
}

function axisLock(
  anchor: readonly [number, number] | null | undefined,
  cursor: readonly [number, number],
  tolerance: number,
): [number, number] | null {
  if (!anchor || !(tolerance > 0)) return null
  const dx = Math.abs(cursor[0] - anchor[0])
  const dy = Math.abs(cursor[1] - anchor[1])
  if (dy <= tolerance && dx > tolerance) return [cursor[0], anchor[1]]
  if (dx <= tolerance && dy > tolerance) return [anchor[0], cursor[1]]
  return null
}

function featurePoints(
  entities: readonly SketchEntity[],
  slot: 'endpoint' | 'midpoint',
): Array<[number, number]> {
  const points: Array<[number, number]> = []
  for (const entity of entities) {
    if (slot === 'endpoint') pushEndpoints(points, entity)
    else pushMidpoints(points, entity)
  }
  return points
}

function pushEndpoints(points: Array<[number, number]>, entity: SketchEntity) {
  switch (entity.kind) {
    case 'point':
      points.push([entity.x, entity.y])
      return
    case 'line':
      points.push([entity.x1, entity.y1], [entity.x2, entity.y2])
      return
    case 'rect':
      points.push(
        [entity.x, entity.y],
        [entity.x + entity.width, entity.y],
        [entity.x + entity.width, entity.y + entity.height],
        [entity.x, entity.y + entity.height],
      )
      return
    case 'arc': {
      const start = polar(entity.cx, entity.cy, entity.radius, entity.startAngle)
      const end = polar(entity.cx, entity.cy, entity.radius, entity.endAngle)
      if (start) points.push(start)
      if (end) points.push(end)
      return
    }
    default:
      return
  }
}

function pushMidpoints(points: Array<[number, number]>, entity: SketchEntity) {
  switch (entity.kind) {
    case 'line': {
      if (Math.hypot(entity.x2 - entity.x1, entity.y2 - entity.y1) <= EPS) return
      points.push([(entity.x1 + entity.x2) / 2, (entity.y1 + entity.y2) / 2])
      return
    }
    case 'rect': {
      const x2 = entity.x + entity.width
      const y2 = entity.y + entity.height
      points.push(
        [(entity.x + x2) / 2, entity.y],
        [x2, (entity.y + y2) / 2],
        [(entity.x + x2) / 2, y2],
        [entity.x, (entity.y + y2) / 2],
      )
      return
    }
    case 'arc': {
      if (!(entity.radius > EPS)) return
      let sweep = entity.endAngle - entity.startAngle
      while (sweep < 0) sweep += Math.PI * 2
      const mid = polar(entity.cx, entity.cy, entity.radius, entity.startAngle + sweep / 2)
      if (mid) points.push(mid)
      return
    }
    default:
      return
  }
}

function polar(cx: number, cy: number, radius: number, angle: number): [number, number] | null {
  if (!(radius > EPS)) return null
  return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]
}
