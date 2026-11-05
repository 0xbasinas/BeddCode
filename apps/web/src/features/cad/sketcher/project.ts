import type { SketchEntity } from './types.ts'

/**
 * Planes the viewport sketches on. Z is up.
 * XY is the floor (top of a plate). YZ is the right wall.
 * ZX is the front wall, the vertical XZ plane.
 */
export type SketchPlaneName = 'XY' | 'YZ' | 'ZX'

export type SketchToolName = 'line' | 'rectangle' | 'circle' | 'arc'

export type StandardView = 'front' | 'top' | 'right' | 'iso'

export interface PlaneFrame {
  u: readonly [number, number, number]
  v: readonly [number, number, number]
  normal: readonly [number, number, number]
}

/**
 * A sketch plane in world millimetres. Named datums use the origin.
 * A face plane carries the face point and the same kind of axes.
 */
export interface WorkPlane {
  origin: readonly [number, number, number]
  u: readonly [number, number, number]
  v: readonly [number, number, number]
  normal: readonly [number, number, number]
}

export type PlaneArg = SketchPlaneName | WorkPlane

/**
 * Local axes match replicad's named planes, so the overlay sits on the solid.
 * XY floor: +x = +X, +y = +Y. Top view (down −Z) shows +x right and +y up.
 * YZ right wall: +x = +Y, +y = +Z. Right view shows +x right and +y up.
 * ZX front wall (XZ plane): +x = +Z, +y = +X, normal = +Y.
 */
const FRAMES: Record<SketchPlaneName, PlaneFrame> = {
  XY: { u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
  YZ: { u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] },
  ZX: { u: [0, 0, 1], v: [1, 0, 0], normal: [0, 1, 0] },
}

/** World up for the camera and for orbit. Every standard view keeps this. */
export const CAMERA_UP: readonly [number, number, number] = [0, 0, 1]

/** Iso eye position. Looking back at the origin shows the top of a plate on XY. */
export const DEFAULT_CAMERA_POSITION: readonly [number, number, number] = [90, -70, 70]

const ISO_DIRECTION = unit(1, -1, 0.8)

/** Direction from the orbit target to the camera. Top is +Z, front is +Y, right is +X. */
export function viewDirection(view: StandardView): readonly [number, number, number] {
  switch (view) {
    case 'top':
      return [0, 0, 1]
    case 'front':
      return [0, 1, 0]
    case 'right':
      return [1, 0, 0]
    case 'iso':
      return ISO_DIRECTION
  }
}

/**
 * Euler XYZ rotation that lays three's XZ GridHelper on the sketch plane.
 * XY rotates X by π/2 onto the floor. ZX stays on XZ, vertical when Z is up.
 */
export function gridRotation(plane: SketchPlaneName): readonly [number, number, number] {
  if (plane === 'XY') return [Math.PI / 2, 0, 0]
  if (plane === 'YZ') return [0, 0, Math.PI / 2]
  return [0, 0, 0]
}

/**
 * World-space edge hit radius. It grows with camera distance so orbiting
 * farther away still leaves an edge selectable.
 */
export function edgePickThreshold(distance: number): number {
  if (!(distance > 0) || !Number.isFinite(distance)) return 0.6
  return Math.min(6, Math.max(0.45, distance * 0.0045))
}

function unit(x: number, y: number, z: number): readonly [number, number, number] {
  const length = Math.hypot(x, y, z)
  return [x / length, y / length, z / length]
}

function dot3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

const EPS = 1e-6

export function planeFrame(plane: SketchPlaneName): PlaneFrame {
  return FRAMES[plane]
}

export function isWorkPlane(plane: PlaneArg): plane is WorkPlane {
  return typeof plane !== 'string'
}

/** Named planes sit on the world origin. A face plane is used as given. */
export function asWorkPlane(plane: PlaneArg): WorkPlane {
  if (isWorkPlane(plane)) return plane
  const frame = FRAMES[plane]
  return { origin: [0, 0, 0], u: frame.u, v: frame.v, normal: frame.normal }
}

/** Stable key so a freshly built frame does not reset an in-progress sketch. */
export function planeKey(plane: PlaneArg): string {
  const frame = asWorkPlane(plane)
  const nums = [...frame.origin, ...frame.u, ...frame.v, ...frame.normal]
  return nums.map((value) => value.toFixed(4)).join(',')
}

/**
 * Right-handed axes for an arbitrary normal. U is the world axis least
 * aligned with the normal, projected into the plane. V is normal × u.
 */
export function workPlaneFromNormal(
  origin: readonly [number, number, number],
  normal: readonly [number, number, number],
): WorkPlane {
  const length = Math.hypot(normal[0], normal[1], normal[2])
  const n = length > 1e-8 ? unit(normal[0], normal[1], normal[2]) : ([0, 0, 1] as const)
  const axes: Array<readonly [number, number, number]> = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  let hint = axes[0] ?? ([1, 0, 0] as const)
  let best = Math.abs(dot3(n, hint))
  for (const axis of axes) {
    const score = Math.abs(dot3(n, axis))
    if (score < best - 1e-8) {
      hint = axis
      best = score
    }
  }
  const along = dot3(hint, n)
  const projected: [number, number, number] = [
    hint[0] - n[0] * along,
    hint[1] - n[1] * along,
    hint[2] - n[2] * along,
  ]
  const span = Math.hypot(projected[0], projected[1], projected[2])
  const u = span > 1e-8 ? unit(projected[0], projected[1], projected[2]) : ([1, 0, 0] as const)
  const v = cross3(n, u)
  return {
    origin: [origin[0], origin[1], origin[2]],
    u,
    v,
    normal: [n[0], n[1], n[2]],
  }
}

export function toWorld(plane: PlaneArg, x: number, y: number): [number, number, number] {
  const { origin, u, v } = asWorkPlane(plane)
  return [
    origin[0] + u[0] * x + v[0] * y,
    origin[1] + u[1] * x + v[1] * y,
    origin[2] + u[2] * x + v[2] * y,
  ]
}

/** Ray against the sketch plane. `t < 0` and parallel rays miss. */
export function projectRayToPlane(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  plane: PlaneArg,
): [number, number] | null {
  const frame = asWorkPlane(plane)
  const denom = dot3(direction, frame.normal)
  if (Math.abs(denom) < 1e-8) return null
  const offset: [number, number, number] = [
    frame.origin[0] - origin[0],
    frame.origin[1] - origin[1],
    frame.origin[2] - origin[2],
  ]
  const t = dot3(offset, frame.normal) / denom
  if (t < 0) return null
  const px = origin[0] + direction[0] * t
  const py = origin[1] + direction[1] * t
  const pz = origin[2] + direction[2] * t
  const dx = px - frame.origin[0]
  const dy = py - frame.origin[1]
  const dz = pz - frame.origin[2]
  return [
    dx * frame.u[0] + dy * frame.u[1] + dz * frame.u[2],
    dx * frame.v[0] + dy * frame.v[1] + dz * frame.v[2],
  ]
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
