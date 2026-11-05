import type { SketchEntity } from './types.ts'

/** Planes the viewport sketches on. Y is up: XY front, YZ right, ZX top. */
export type SketchPlaneName = 'XY' | 'YZ' | 'ZX'

export type SketchToolName = 'line' | 'rectangle' | 'circle' | 'arc'

export interface PlaneFrame {
  u: readonly [number, number, number]
  v: readonly [number, number, number]
  normal: readonly [number, number, number]
}

/**
 * Sketch +x is screen-right and sketch +y is screen-up in the matching standard view.
 * Front looks along -Z, right along -X, top along -Y with up = -Z.
 */
const FRAMES: Record<SketchPlaneName, PlaneFrame> = {
  XY: { u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
  YZ: { u: [0, 0, -1], v: [0, 1, 0], normal: [1, 0, 0] },
  ZX: { u: [1, 0, 0], v: [0, 0, -1], normal: [0, 1, 0] },
}

const EPS = 1e-6

export function planeFrame(plane: SketchPlaneName): PlaneFrame {
  return FRAMES[plane]
}

export function toWorld(plane: SketchPlaneName, x: number, y: number): [number, number, number] {
  const { u, v } = FRAMES[plane]
  return [u[0] * x + v[0] * y, u[1] * x + v[1] * y, u[2] * x + v[2] * y]
}

/** Ray against the sketch plane through the origin. `t < 0` and parallel rays miss. */
export function projectRayToPlane(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  plane: SketchPlaneName,
): [number, number] | null {
  const { u, v, normal } = FRAMES[plane]
  const denom = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2]
  if (Math.abs(denom) < 1e-8) return null
  const t = -(origin[0] * normal[0] + origin[1] * normal[1] + origin[2] * normal[2]) / denom
  if (t < 0) return null
  const px = origin[0] + direction[0] * t
  const py = origin[1] + direction[1] * t
  const pz = origin[2] + direction[2] * t
  return [px * u[0] + py * u[1] + pz * u[2], px * v[0] + py * v[1] + pz * v[2]]
}

export function snapToGrid(value: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(value)) return value
  const cleaned = Number((Math.round(value / step) * step).toFixed(6))
  return Object.is(cleaned, -0) ? 0 : cleaned
}

export function snapPoint(point: readonly [number, number], step: number): [number, number] {
  return [snapToGrid(point[0], step), snapToGrid(point[1], step)]
}

export function formatLength(mm: number): string {
  if (!Number.isFinite(mm)) return ''
  const rounded = Math.round(mm * 10) / 10
  if (Object.is(rounded, -0) || rounded === 0) return '0'
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export function worldDistance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

export function pointsDiffer(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) > EPS
}

export function arcPolyline(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  segments = 64,
): Array<[number, number]> {
  if (!(radius > EPS)) return []
  let sweep = endAngle - startAngle
  while (sweep < 0) sweep += Math.PI * 2
  if (sweep < 1e-5) return []
  const steps = Math.max(8, Math.ceil((segments * sweep) / (Math.PI * 2)))
  const points: Array<[number, number]> = []
  for (let i = 0; i <= steps; i++) {
    const angle = startAngle + (sweep * i) / steps
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
  }
  return points
}

function rectLoop(x1: number, y1: number, x2: number, y2: number): Array<[number, number]> | null {
  if (Math.abs(x2 - x1) <= EPS || Math.abs(y2 - y1) <= EPS) return null
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const xMax = Math.max(x1, x2)
  const yMax = Math.max(y1, y2)
  return [
    [x, y],
    [xMax, y],
    [xMax, yMax],
    [x, yMax],
    [x, y],
  ]
}

/** Closed polyline in sketch millimetres. A point is a small diamond. */
export function entityPolyline(entity: SketchEntity): Array<[number, number]> | null {
  switch (entity.kind) {
    case 'point': {
      const r = 1.25
      return [
        [entity.x, entity.y + r],
        [entity.x + r, entity.y],
        [entity.x, entity.y - r],
        [entity.x - r, entity.y],
        [entity.x, entity.y + r],
      ]
    }
    case 'line':
      if (!pointsDiffer([entity.x1, entity.y1], [entity.x2, entity.y2])) return null
      return [
        [entity.x1, entity.y1],
        [entity.x2, entity.y2],
      ]
    case 'rect':
      return rectLoop(entity.x, entity.y, entity.x + entity.width, entity.y + entity.height)
    case 'circle':
      return arcPolyline(entity.cx, entity.cy, entity.radius, 0, Math.PI * 2)
    case 'arc':
      return arcPolyline(entity.cx, entity.cy, entity.radius, entity.startAngle, entity.endAngle)
    default:
      return null
  }
}

export interface SketchAnnotation {
  text: string
  at: [number, number]
}

/** Length for a line, radius for a circle or arc, size for a rectangle. */
export function entityAnnotation(entity: SketchEntity): SketchAnnotation | null {
  switch (entity.kind) {
    case 'line': {
      const length = Math.hypot(entity.x2 - entity.x1, entity.y2 - entity.y1)
      if (!(length > EPS)) return null
      return {
        text: formatLength(length),
        at: [(entity.x1 + entity.x2) / 2, (entity.y1 + entity.y2) / 2],
      }
    }
    case 'circle':
      if (!(entity.radius > EPS)) return null
      return {
        text: `R ${formatLength(entity.radius)}`,
        at: [entity.cx + entity.radius, entity.cy],
      }
    case 'rect':
      return {
        text: `${formatLength(entity.width)} × ${formatLength(entity.height)}`,
        at: [entity.x + entity.width / 2, entity.y + entity.height / 2],
      }
    case 'arc': {
      if (!(entity.radius > EPS)) return null
      let sweep = entity.endAngle - entity.startAngle
      while (sweep < 0) sweep += Math.PI * 2
      const mid = entity.startAngle + sweep / 2
      return {
        text: `R ${formatLength(entity.radius)}`,
        at: [entity.cx + Math.cos(mid) * entity.radius, entity.cy + Math.sin(mid) * entity.radius],
      }
    }
    default:
      return null
  }
}

/**
 * Click-to-add. A line chains from its end. Rectangle, circle, and arc finish
 * and clear the placed points. A too-small click leaves the draft alone.
 */
export function advanceSketch(
  tool: SketchToolName,
  placed: readonly (readonly [number, number])[],
  cursor: readonly [number, number],
  id: string,
): { placed: Array<[number, number]>; entity: SketchEntity | null } {
  const point: [number, number] = [cursor[0], cursor[1]]
  if (tool === 'line') {
    const start = placed[0]
    if (!start) return { placed: [point], entity: null }
    if (!pointsDiffer(start, point)) return { placed: [[start[0], start[1]]], entity: null }
    return {
      placed: [point],
      entity: { id, kind: 'line', x1: start[0], y1: start[1], x2: point[0], y2: point[1] },
    }
  }
  if (tool === 'rectangle') {
    const origin = placed[0]
    if (!origin) return { placed: [point], entity: null }
    const width = point[0] - origin[0]
    const height = point[1] - origin[1]
    if (Math.abs(width) <= EPS || Math.abs(height) <= EPS) {
      return { placed: [[origin[0], origin[1]]], entity: null }
    }
    return {
      placed: [],
      entity: {
        id,
        kind: 'rect',
        x: Math.min(origin[0], point[0]),
        y: Math.min(origin[1], point[1]),
        width: Math.abs(width),
        height: Math.abs(height),
      },
    }
  }
  if (tool === 'circle') {
    const center = placed[0]
    if (!center) return { placed: [point], entity: null }
    const radius = Math.hypot(point[0] - center[0], point[1] - center[1])
    if (radius <= EPS) return { placed: [[center[0], center[1]]], entity: null }
    return {
      placed: [],
      entity: { id, kind: 'circle', cx: center[0], cy: center[1], radius },
    }
  }
  const center = placed[0]
  if (!center) return { placed: [point], entity: null }
  const start = placed[1]
  if (!start) {
    if (!pointsDiffer(center, point)) return { placed: [[center[0], center[1]]], entity: null }
    return {
      placed: [[center[0], center[1]], point],
      entity: null,
    }
  }
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1])
  if (!(radius > EPS)) {
    return {
      placed: [
        [center[0], center[1]],
        [start[0], start[1]],
      ],
      entity: null,
    }
  }
  return {
    placed: [],
    entity: {
      id,
      kind: 'arc',
      cx: center[0],
      cy: center[1],
      radius,
      startAngle: Math.atan2(start[1] - center[1], start[0] - center[0]),
      endAngle: Math.atan2(point[1] - center[1], point[0] - center[0]),
    },
  }
}

/** Rubber-band geometry for the point under the cursor. */
export function previewPolyline(
  tool: SketchToolName,
  placed: readonly (readonly [number, number])[],
  cursor: readonly [number, number] | null,
): Array<[number, number]> | null {
  if (!cursor || placed.length === 0) return null
  if (tool === 'line') {
    const start = placed[0]
    if (!start || !pointsDiffer(start, cursor)) return null
    return [
      [start[0], start[1]],
      [cursor[0], cursor[1]],
    ]
  }
  if (tool === 'rectangle') {
    const origin = placed[0]
    if (!origin) return null
    return rectLoop(origin[0], origin[1], cursor[0], cursor[1])
  }
  if (tool === 'circle') {
    const center = placed[0]
    if (!center) return null
    const radius = Math.hypot(cursor[0] - center[0], cursor[1] - center[1])
    if (!(radius > EPS)) return null
    return arcPolyline(center[0], center[1], radius, 0, Math.PI * 2)
  }
  const center = placed[0]
  if (!center) return null
  if (!placed[1]) {
    if (!pointsDiffer(center, cursor)) return null
    return [
      [center[0], center[1]],
      [cursor[0], cursor[1]],
    ]
  }
  const start = placed[1]
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1])
  if (!(radius > EPS)) return null
  return arcPolyline(
    center[0],
    center[1],
    radius,
    Math.atan2(start[1] - center[1], start[0] - center[0]),
    Math.atan2(cursor[1] - center[1], cursor[0] - center[0]),
  )
}

export function previewAnnotation(
  tool: SketchToolName,
  placed: readonly (readonly [number, number])[],
  cursor: readonly [number, number] | null,
): SketchAnnotation | null {
  const poly = previewPolyline(tool, placed, cursor)
  if (!poly || !cursor) return null
  if (tool === 'line') {
    const start = placed[0]
    if (!start) return null
    return {
      text: formatLength(Math.hypot(cursor[0] - start[0], cursor[1] - start[1])),
      at: [(start[0] + cursor[0]) / 2, (start[1] + cursor[1]) / 2],
    }
  }
  if (tool === 'rectangle') {
    const origin = placed[0]
    if (!origin) return null
    return {
      text: `${formatLength(Math.abs(cursor[0] - origin[0]))} × ${formatLength(Math.abs(cursor[1] - origin[1]))}`,
      at: [(origin[0] + cursor[0]) / 2, (origin[1] + cursor[1]) / 2],
    }
  }
  if (tool === 'circle') {
    const center = placed[0]
    if (!center) return null
    const radius = Math.hypot(cursor[0] - center[0], cursor[1] - center[1])
    return { text: `R ${formatLength(radius)}`, at: [center[0] + radius, center[1]] }
  }
  const center = placed[0]
  if (!center) return null
  const start = placed[1]
  const radius = start
    ? Math.hypot(start[0] - center[0], start[1] - center[1])
    : Math.hypot(cursor[0] - center[0], cursor[1] - center[1])
  if (!(radius > EPS)) return null
  return { text: `R ${formatLength(radius)}`, at: [center[0] + radius, center[1]] }
}
