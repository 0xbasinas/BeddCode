import { faceCandidatesFromMesh } from './topologyRefs'
import type {
  AxisName,
  BooleanMode,
  BoxParams,
  Counterbore,
  CylinderParams,
  EdgeTopologyRef,
  FaceGroup,
  FeatureDocument,
  FeatureOp,
  HoleDirection,
  MeshBuffer,
  PlaneName,
  PrimitiveKind,
  PrimitiveParams,
  Profile2D,
  SphereParams,
} from './types'

const PLANES: readonly PlaneName[] = ['XY', 'YZ', 'ZX', 'XZ', 'YX', 'ZY']
const AXES: readonly AxisName[] = ['X', 'Y', 'Z', '-X', '-Y', '-Z']
const HOLE_DIRECTIONS: readonly HoleDirection[] = ['X', 'Y', 'Z', '-X', '-Y', '-Z', 'normal']
const PRIMITIVES: readonly PrimitiveKind[] = ['box', 'cylinder', 'sphere']
const BOOLEANS: readonly BooleanMode[] = ['fuse', 'cut', 'intersect']

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function assertId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error('feature id must be a non-empty string')
  }
}

function assertPositive(name: string, value: unknown): asserts value is number {
  if (!isFiniteNumber(value) || value <= 0) throw new Error(`${name} must be a positive number`)
}

function assertNonZero(name: string, value: unknown): asserts value is number {
  if (!isFiniteNumber(value) || value === 0)
    throw new Error(`${name} must be a non-zero finite number`)
}

function isPlane(value: unknown): value is PlaneName {
  return typeof value === 'string' && (PLANES as readonly string[]).includes(value)
}

function isAxis(value: unknown): value is AxisName {
  return typeof value === 'string' && (AXES as readonly string[]).includes(value)
}

function paramsOf(kind: PrimitiveKind, value: unknown): PrimitiveParams {
  if (!value || typeof value !== 'object') throw new Error('primitive params are missing')
  const record = value as Record<string, unknown>
  if (kind === 'box') {
    assertPositive('width', record.width)
    assertPositive('depth', record.depth)
    assertPositive('height', record.height)
    const params: BoxParams = { width: record.width, depth: record.depth, height: record.height }
    return params
  }
  if (kind === 'cylinder') {
    assertPositive('radius', record.radius)
    assertPositive('height', record.height)
    const params: CylinderParams = { radius: record.radius, height: record.height }
    return params
  }
  assertPositive('radius', record.radius)
  const params: SphereParams = { radius: record.radius }
  return params
}

/** Checks a sketch profile. Shared by the planner and the kernel. */
export function normalizeProfile(value: unknown): Profile2D {
  if (!value || typeof value !== 'object') throw new Error('profile is missing')
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.points) || record.points.length < 3) {
    throw new Error('profile needs at least 3 points')
  }
  const points: Array<[number, number]> = []
  for (const point of record.points) {
    if (!Array.isArray(point) || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
      throw new Error('profile points must be finite [x, y] pairs')
    }
    points.push([point[0], point[1]])
  }
  if (record.plane === undefined) return { points }
  if (!isPlane(record.plane)) throw new Error('unknown profile plane')
  return { points, plane: record.plane }
}

function knownShape(value: unknown, seen: Set<string>): string {
  assertId(value)
  if (!seen.has(value)) throw new Error(`unknown shape ${value}`)
  return value
}

/** A shape id that must already exist. Names the missing piece in the error. */
function requiredShape(value: unknown, seen: Set<string>, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`)
  if (value.length > 128) throw new Error('feature id must be a non-empty string')
  if (!seen.has(value)) throw new Error(`${label} ${value} is missing`)
  return value
}

function optionalBoolean(name: string, value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

/** Empty means "every edge", same as omitting the field. */
function optionalEdgeIds(value: unknown): number[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('edgeIds must be an array of integers')
  if (value.length === 0) return undefined
  const ids: number[] = []
  for (const id of value) {
    if (!isFiniteNumber(id) || !Number.isInteger(id)) {
      throw new Error('edgeIds must be an array of integers')
    }
    ids.push(id)
  }
  return ids
}

function readPoint(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${label} must be a finite [x, y, z]`)
  }
  const x = value[0]
  const y = value[1]
  const z = value[2]
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    throw new Error(`${label} must be a finite [x, y, z]`)
  }
  return [x, y, z]
}

function readEdgeRef(value: unknown): EdgeTopologyRef {
  if (!value || typeof value !== 'object') throw new Error('edge ref must be an object')
  const record = value as Record<string, unknown>
  if (record.kind !== 'edge') throw new Error('edge ref kind must be edge')
  assertPositive('edge length', record.length)
  return {
    kind: 'edge',
    mid: readPoint(record.mid, 'edge midpoint'),
    dir: readPoint(record.dir, 'edge direction'),
    length: record.length,
  }
}

/** Empty means there is nothing to rematch, same as omitting the field. */
function optionalEdgeRefs(value: unknown): EdgeTopologyRef[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('edgeRefs must be an array')
  if (value.length === 0) return undefined
  return value.map((item) => readEdgeRef(item))
}

function holeDirection(value: unknown): HoleDirection | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && (HOLE_DIRECTIONS as readonly string[]).includes(value)) {
    return value as HoleDirection
  }
  throw new Error('unknown hole direction')
}

function readCounterbore(
  value: unknown,
  diameter: number,
  depth: number | undefined,
  throughAll: boolean,
): Counterbore | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error('counterbore must be an object')
  const record = value as Record<string, unknown>
  assertPositive('counterbore diameter', record.diameter)
  assertPositive('counterbore depth', record.depth)
  if (record.diameter <= diameter) {
    throw new Error('counterbore diameter must be larger than the hole')
  }
  if (!throughAll && depth !== undefined && record.depth >= depth) {
    throw new Error('counterbore depth must be shorter than the hole')
  }
  return { diameter: record.diameter, depth: record.depth }
}

function readOp(value: unknown, seen: Set<string>): FeatureOp {
  if (!value || typeof value !== 'object') throw new Error('feature op must be an object')
  const record = value as Record<string, unknown>
  assertId(record.id)
  if (seen.has(record.id)) throw new Error(`duplicate feature id ${record.id}`)

  let feature: FeatureOp
  switch (record.op) {
    case 'primitive': {
      if (!(PRIMITIVES as readonly string[]).includes(String(record.kind))) {
        throw new Error('unknown primitive')
      }
      const kind = record.kind as PrimitiveKind
      feature = { op: 'primitive', id: record.id, kind, params: paramsOf(kind, record.params) }
      break
    }
    case 'extrude': {
      assertNonZero('distance', record.distance)
      const bothSides = optionalBoolean('bothSides', record.bothSides)
      const cut = optionalBoolean('cut', record.cut)
      if (record.target !== undefined && !cut) throw new Error('extrude target requires cut')
      const target = cut ? requiredShape(record.target, seen, 'extrude cut target') : undefined
      feature = {
        op: 'extrude',
        id: record.id,
        profile: normalizeProfile(record.profile),
        distance: record.distance,
        ...(bothSides ? { bothSides: true } : {}),
        ...(target ? { cut: true, target } : {}),
      }
      break
    }
    case 'revolve': {
      assertNonZero('angle', record.angle)
      if (Math.abs(record.angle) > 360) throw new Error('revolve angle must be within 360 degrees')
      if (record.profile === undefined || record.profile === null) {
        throw new Error('revolve profile is missing')
      }
      if (record.axis === null || record.axis === '') throw new Error('revolve axis is missing')
      const axis = record.axis === undefined ? undefined : record.axis
      if (axis !== undefined && !isAxis(axis)) throw new Error('unknown revolve axis')
      feature = {
        op: 'revolve',
        id: record.id,
        profile: normalizeProfile(record.profile),
        angle: record.angle,
        ...(axis ? { axis } : {}),
      }
      break
    }
    case 'fillet': {
      assertPositive('radius', record.radius)
      const edgeIds = optionalEdgeIds(record.edgeIds)
      const edgeRefs = optionalEdgeRefs(record.edgeRefs)
      feature = {
        op: 'fillet',
        id: record.id,
        target: knownShape(record.target, seen),
        radius: record.radius,
        ...(edgeIds ? { edgeIds } : {}),
        ...(edgeRefs ? { edgeRefs } : {}),
      }
      break
    }
    case 'chamfer': {
      assertPositive('radius', record.radius)
      const edgeIds = optionalEdgeIds(record.edgeIds)
      const edgeRefs = optionalEdgeRefs(record.edgeRefs)
      feature = {
        op: 'chamfer',
        id: record.id,
        target: knownShape(record.target, seen),
        radius: record.radius,
        ...(edgeIds ? { edgeIds } : {}),
        ...(edgeRefs ? { edgeRefs } : {}),
      }
      break
    }
    case 'hole': {
      assertPositive('diameter', record.diameter)
      const throughAll = optionalBoolean('throughAll', record.throughAll)
      let depth: number | undefined
      if (record.depth !== undefined) {
        assertPositive('depth', record.depth)
        depth = record.depth
      }
      if (!throughAll && depth === undefined) throw new Error('hole depth is missing')
      const direction = holeDirection(record.direction)
      const counterbore = readCounterbore(record.counterbore, record.diameter, depth, throughAll)
      feature = {
        op: 'hole',
        id: record.id,
        target: knownShape(record.target, seen),
        origin: readPoint(record.origin, 'hole origin'),
        diameter: record.diameter,
        ...(direction ? { direction } : {}),
        ...(depth !== undefined ? { depth } : {}),
        ...(throughAll ? { throughAll: true } : {}),
        ...(counterbore ? { counterbore } : {}),
      }
      break
    }
    case 'boolean': {
      if (!(BOOLEANS as readonly string[]).includes(String(record.mode)))
        throw new Error('unknown boolean mode')
      const target = requiredShape(record.target, seen, 'boolean target')
      const tool = requiredShape(record.tool, seen, 'boolean tool')
      if (target === tool) throw new Error('boolean target and tool must differ')
      feature = { op: 'boolean', id: record.id, mode: record.mode as BooleanMode, target, tool }
      break
    }
    case 'importStep': {
      if (typeof record.name !== 'string' || record.name.length === 0) {
        throw new Error('STEP import needs a name')
      }
      feature = { op: 'importStep', id: record.id, name: record.name }
      break
    }
    default:
      throw new Error('unknown feature op')
  }

  seen.add(feature.id)
  return feature
}

/**
 * Validates a feature document and returns the ops in replay order.
 * Pure: no OpenCascade, so unit tests can run without the WASM binary.
 */
export function planRebuild(input: unknown): FeatureOp[] {
  if (!input || typeof input !== 'object') throw new Error('feature document must be an object')
  const record = input as Record<string, unknown>
  if (record.version !== 1) throw new Error('unsupported feature document version')
  if (!Array.isArray(record.ops)) throw new Error('feature document ops must be an array')
  const seen = new Set<string>()
  return record.ops.map((op) => readOp(op, seen))
}

export function parseFeatureDocument(text: string): FeatureDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('feature document is not json')
  }
  return { version: 1, ops: planRebuild(raw) }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stable(item))
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = stable(record[key])
    return sorted
  }
  return value
}

/** Canonical JSON for a feature document. Rejects a document that cannot be rebuilt. */
export function serializeFeatureDocument(input: unknown): string {
  const ops = planRebuild(input)
  return JSON.stringify(stable({ version: 1, ops }))
}

type Vec3 = [number, number, number]

/** Click on a face, plus the plane that face lies in. `normal` points out of the solid. */
export interface HoleFacePoint {
  point: readonly [number, number, number]
  normal: readonly [number, number, number]
  /** Any point on the face plane. Defaults to `point` when the hit is already on it. */
  planeOrigin?: readonly [number, number, number]
}

/** Hole center on the face, and the drill axis into the solid. */
export interface HoleAxis {
  origin: Vec3
  direction: HoleDirection
}

const DRILL_AXES: readonly { name: HoleDirection; vector: Vec3 }[] = [
  { name: 'X', vector: [1, 0, 0] },
  { name: '-X', vector: [-1, 0, 0] },
  { name: 'Y', vector: [0, 1, 0] },
  { name: '-Y', vector: [0, -1, 0] },
  { name: 'Z', vector: [0, 0, 1] },
  { name: '-Z', vector: [0, 0, -1] },
]

function tidy(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6
  return rounded === 0 ? 0 : rounded
}

function asUnit(value: readonly [number, number, number]): Vec3 | null {
  const length = Math.hypot(value[0], value[1], value[2])
  if (length < 1e-9) return null
  return [value[0] / length, value[1] / length, value[2] / length]
}

function readVertex(positions: ArrayLike<number>, index: number): Vec3 | null {
  const x = positions[index * 3]
  const y = positions[index * 3 + 1]
  const z = positions[index * 3 + 2]
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return [x, y, z]
}

/**
 * Projects the click onto the face and aims the drill into the material.
 * An axis-aligned outward normal becomes `-X`…`Z`. Any other face stays
 * `normal`, which the kernel resolves on the target solid.
 */
export function holeAxisFromFacePoint(face: HoleFacePoint): HoleAxis {
  const normal = asUnit(face.normal)
  if (!normal) throw new Error('hole face normal is missing')
  const anchor = face.planeOrigin ?? face.point
  const distance =
    (face.point[0] - anchor[0]) * normal[0] +
    (face.point[1] - anchor[1]) * normal[1] +
    (face.point[2] - anchor[2]) * normal[2]
  const origin: Vec3 = [
    tidy(face.point[0] - normal[0] * distance),
    tidy(face.point[1] - normal[1] * distance),
    tidy(face.point[2] - normal[2] * distance),
  ]
  const into: Vec3 = [-normal[0], -normal[1], -normal[2]]
  let direction: HoleDirection = 'normal'
  for (const axis of DRILL_AXES) {
    const dot = into[0] * axis.vector[0] + into[1] * axis.vector[1] + into[2] * axis.vector[2]
    if (dot > 0.999) {
      direction = axis.name
      break
    }
  }
  return { origin, direction }
}

/** Plane of one triangle. The normal follows vertex normals when those point outward. */
export function frameFromTriangle(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | undefined,
  triangleIndex: number,
  normals?: ArrayLike<number>,
): { origin: Vec3; normal: Vec3 } | null {
  if (!Number.isInteger(triangleIndex) || triangleIndex < 0) return null
  const corners: number[] = []
  for (let slot = 0; slot < 3; slot += 1) {
    const raw = indices ? indices[triangleIndex * 3 + slot] : triangleIndex * 3 + slot
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null
    corners.push(raw)
  }
  const first = corners[0]
  const second = corners[1]
  const third = corners[2]
  if (first === undefined || second === undefined || third === undefined) return null
  const a = readVertex(positions, first)
  const b = readVertex(positions, second)
  const c = readVertex(positions, third)
  if (!a || !b || !c) return null
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  let normal = asUnit([
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ])
  if (!normal) return null
  if (normals) {
    const samples: Vec3[] = []
    for (const index of corners) {
      const sample = readVertex(normals, index)
      if (sample) samples.push(sample)
    }
    if (samples.length > 0) {
      const averaged = asUnit([
        samples.reduce((sum, sample) => sum + sample[0], 0),
        samples.reduce((sum, sample) => sum + sample[1], 0),
        samples.reduce((sum, sample) => sum + sample[2], 0),
      ])
      if (averaged) {
        const dot = normal[0] * averaged[0] + normal[1] * averaged[1] + normal[2] * averaged[2]
        if (dot < 0) normal = [-normal[0], -normal[1], -normal[2]]
      }
    }
  }
  return { origin: a, normal }
}

export interface FaceMesh {
  positions: Float32Array
  normals?: Float32Array
  indices?: Uint32Array
  faceGroups?: FaceGroup[]
}

/**
 * Plane of the picked face. A `faceId` uses the whole face. Otherwise the
 * hit triangle supplies the plane.
 */
export function faceFrameFromMesh(
  mesh: FaceMesh,
  triangleIndex: number,
  faceId?: number,
): { origin: Vec3; normal: Vec3 } | null {
  if (faceId !== undefined && mesh.faceGroups && mesh.indices && mesh.normals) {
    const buffer: MeshBuffer = {
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      faceGroups: mesh.faceGroups,
    }
    const found = faceCandidatesFromMesh(buffer).find((face) => face.faceId === faceId)
    if (found) return { origin: found.origin, normal: found.normal }
  }
  return frameFromTriangle(mesh.positions, mesh.indices, triangleIndex, mesh.normals)
}
