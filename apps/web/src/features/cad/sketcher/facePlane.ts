import { workPlaneFromNormal, type SketchPlaneName } from './project.ts'

/** Triangle mesh slice used to build a sketch plane. Ranges count triangles. */
export interface FaceMesh {
  positions: ArrayLike<number>
  indices?: ArrayLike<number>
  normals?: ArrayLike<number>
  triangles?: readonly { start: number; count: number }[]
  triangleIndex?: number
}

export type FacePlane =
  | { kind: 'named'; plane: SketchPlaneName }
  | {
      kind: 'frame'
      /** Nearest datum. Axis-aligned faces keep that datum's name. */
      plane: SketchPlaneName
      origin: [number, number, number]
      normal: [number, number, number]
      u: [number, number, number]
      v: [number, number, number]
    }

/** How close a unit normal must be to a world axis to count as that datum. */
const AXIS = 0.999
/** A face this close to the origin, in millimetres, lies on the datum. */
const ON_DATUM = 0.05

/**
 * Sketch plane for one face.
 * A face on XY, YZ, or ZX through the origin reuses that named plane.
 * Any other planar face stores a frame at the face centroid.
 */
export function planeFromFace(mesh: FaceMesh): FacePlane | null {
  const spans = spansOf(mesh)
  if (spans.length === 0) return null
  const ids: number[] = []
  const seen = new Set<number>()
  let nx = 0
  let ny = 0
  let nz = 0
  for (const span of spans) {
    const start = Math.floor(span.start)
    const count = Math.max(0, Math.floor(span.count))
    for (let tri = start; tri < start + count; tri++) {
      const corner = cornersOf(mesh, tri)
      if (!corner) continue
      const a = at(mesh.positions, corner[0])
      const b = at(mesh.positions, corner[1])
      const c = at(mesh.positions, corner[2])
      if (!a || !b || !c) continue
      const abx = b[0] - a[0]
      const aby = b[1] - a[1]
      const abz = b[2] - a[2]
      const acx = c[0] - a[0]
      const acy = c[1] - a[1]
      const acz = c[2] - a[2]
      nx += aby * acz - abz * acy
      ny += abz * acx - abx * acz
      nz += abx * acy - aby * acx
      for (const index of corner) {
        if (seen.has(index)) continue
        seen.add(index)
        ids.push(index)
      }
    }
  }
  if (ids.length === 0) return null
  let length = Math.hypot(nx, ny, nz)
  if (length < 1e-8 && mesh.normals) {
    nx = 0
    ny = 0
    nz = 0
    for (const index of ids) {
      const normal = at(mesh.normals, index)
      if (!normal) continue
      nx += normal[0]
      ny += normal[1]
      nz += normal[2]
    }
    length = Math.hypot(nx, ny, nz)
  }
  if (!(length > 1e-8)) return null
  const normal: [number, number, number] = [nx / length, ny / length, nz / length]
  let sx = 0
  let sy = 0
  let sz = 0
  let used = 0
  let maxX = 0
  let maxY = 0
  let maxZ = 0
  for (const index of ids) {
    const point = at(mesh.positions, index)
    if (!point) continue
    sx += point[0]
    sy += point[1]
    sz += point[2]
    used += 1
    maxX = Math.max(maxX, Math.abs(point[0]))
    maxY = Math.max(maxY, Math.abs(point[1]))
    maxZ = Math.max(maxZ, Math.abs(point[2]))
  }
  if (used === 0) return null
  const named = namedDatum(normal, maxX, maxY, maxZ)
  if (named) return { kind: 'named', plane: named }
  const origin: [number, number, number] = [round4(sx / used), round4(sy / used), round4(sz / used)]
  const frame = workPlaneFromNormal(origin, normal)
  return {
    kind: 'frame',
    plane: nearestPlane(normal),
    origin,
    normal: [frame.normal[0], frame.normal[1], frame.normal[2]],
    u: [frame.u[0], frame.u[1], frame.u[2]],
    v: [frame.v[0], frame.v[1], frame.v[2]],
  }
}

function namedDatum(
  normal: readonly [number, number, number],
  maxX: number,
  maxY: number,
  maxZ: number,
): SketchPlaneName | null {
  if (Math.abs(normal[2]) >= AXIS && maxZ <= ON_DATUM) return 'XY'
  if (Math.abs(normal[0]) >= AXIS && maxX <= ON_DATUM) return 'YZ'
  if (Math.abs(normal[1]) >= AXIS && maxY <= ON_DATUM) return 'ZX'
  return null
}

function nearestPlane(normal: readonly [number, number, number]): SketchPlaneName {
  const ax = Math.abs(normal[0])
  const ay = Math.abs(normal[1])
  const az = Math.abs(normal[2])
  if (ax >= ay && ax >= az) return 'YZ'
  if (ay >= az) return 'ZX'
  return 'XY'
}

function spansOf(mesh: FaceMesh): { start: number; count: number }[] {
  if (mesh.triangles && mesh.triangles.length > 0)
    return mesh.triangles.map((span) => ({ ...span }))
  if (mesh.triangleIndex !== undefined && mesh.triangleIndex >= 0) {
    return [{ start: mesh.triangleIndex, count: 1 }]
  }
  return []
}

function cornersOf(mesh: FaceMesh, triangle: number): [number, number, number] | null {
  const base = triangle * 3
  if (mesh.indices) {
    const a = mesh.indices[base]
    const b = mesh.indices[base + 1]
    const c = mesh.indices[base + 2]
    if (a === undefined || b === undefined || c === undefined) return null
    return [a, b, c]
  }
  return [base, base + 1, base + 2]
}

function at(values: ArrayLike<number>, index: number): [number, number, number] | null {
  const x = values[index * 3]
  const y = values[index * 3 + 1]
  const z = values[index * 3 + 2]
  if (x === undefined || y === undefined || z === undefined) return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return [x, y, z]
}

function round4(value: number): number {
  const cleaned = Number(value.toFixed(4))
  return Object.is(cleaned, -0) ? 0 : cleaned
}
