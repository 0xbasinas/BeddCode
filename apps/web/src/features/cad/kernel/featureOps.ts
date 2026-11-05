import type {
  AxisName,
  BooleanMode,
  BoxParams,
  CylinderParams,
  FeatureDocument,
  FeatureOp,
  PlaneName,
  PrimitiveKind,
  PrimitiveParams,
  Profile2D,
  SphereParams,
} from './types'

const PLANES: readonly PlaneName[] = ['XY', 'YZ', 'ZX', 'XZ', 'YX', 'ZY']
const AXES: readonly AxisName[] = ['X', 'Y', 'Z', '-X', '-Y', '-Z']
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
      feature = {
        op: 'fillet',
        id: record.id,
        target: knownShape(record.target, seen),
        radius: record.radius,
        ...(edgeIds ? { edgeIds } : {}),
      }
      break
    }
    case 'chamfer': {
      assertPositive('radius', record.radius)
      const edgeIds = optionalEdgeIds(record.edgeIds)
      feature = {
        op: 'chamfer',
        id: record.id,
        target: knownShape(record.target, seen),
        radius: record.radius,
        ...(edgeIds ? { edgeIds } : {}),
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
