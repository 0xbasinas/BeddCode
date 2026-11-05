/**
 * Edge ids and geometric signatures for fillet and chamfer.
 * `edgeIds` is the comma-separated list toFeatureDocument already copies.
 * `edgeRefs` is JSON of `{ kind:'edge', mid, dir, length }` for the kernel's
 * topology rematch. Positions and length are rounded to 0.01 mm.
 */

export interface TopologyRef {
  kind: 'edge'
  mid: [number, number, number]
  dir: [number, number, number]
  length: number
}

export interface EdgeLineMesh {
  edgeGroups?: readonly { start: number; count: number; edgeId: number }[]
  edgePositions?: ArrayLike<number>
  edges?: { positions: ArrayLike<number> }
}

export interface EdgePick {
  edgeId: number
  ref: TopologyRef | null
}

const MM = 100

function stripZero(value: number): number {
  return value === 0 ? 0 : value
}

export function roundMm(value: number): number {
  return stripZero(Math.round(value * MM) / MM)
}

function roundDir(value: number): number {
  return stripZero(Math.round(value * 10000) / 10000)
}

function coord(positions: ArrayLike<number>, index: number): number {
  const value = positions[index]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function vertex(positions: ArrayLike<number>, index: number): [number, number, number] {
  return [
    coord(positions, index * 3),
    coord(positions, index * 3 + 1),
    coord(positions, index * 3 + 2),
  ]
}

/** Signature of one edge polyline. `start` and `count` count vertices in a line-pair buffer. */
export function edgeSignature(
  positions: ArrayLike<number>,
  start: number,
  count: number,
): TopologyRef | null {
  if (count < 2 || start < 0) return null
  const end = Math.min(Math.floor(positions.length / 3), start + count)
  if (end - start < 2) return null

  let length = 0
  let sx = 0
  let sy = 0
  let sz = 0
  let best = 0
  let dx = 0
  let dy = 0
  let dz = 0

  for (let index = start; index + 1 < end; index += 2) {
    const a = vertex(positions, index)
    const b = vertex(positions, index + 1)
    const segX = b[0] - a[0]
    const segY = b[1] - a[1]
    const segZ = b[2] - a[2]
    const seg = Math.hypot(segX, segY, segZ)
    if (seg <= 1e-9) continue
    length += seg
    sx += ((a[0] + b[0]) / 2) * seg
    sy += ((a[1] + b[1]) / 2) * seg
    sz += ((a[2] + b[2]) / 2) * seg
    if (seg > best) {
      best = seg
      dx = segX
      dy = segY
      dz = segZ
    }
  }

  if (length <= 1e-9 || best <= 1e-9) return null
  const span = Math.hypot(dx, dy, dz) || 1
  let dirX = dx / span
  let dirY = dy / span
  let dirZ = dz / span
  const flip =
    dirX < -1e-9 ||
    (Math.abs(dirX) <= 1e-9 && (dirY < -1e-9 || (Math.abs(dirY) <= 1e-9 && dirZ < 0)))
  if (flip) {
    dirX = -dirX
    dirY = -dirY
    dirZ = -dirZ
  }

  return {
    kind: 'edge',
    mid: [roundMm(sx / length), roundMm(sy / length), roundMm(sz / length)],
    dir: [roundDir(dirX), roundDir(dirY), roundDir(dirZ)],
    length: roundMm(length),
  }
}

/** Edge hash plus a signature when the mesh still has that edge's line. */
export function signatureForEdge(
  mesh: EdgeLineMesh,
  edgeId: number | undefined,
  vertexIndex: number,
): EdgePick | null {
  const positions = mesh.edgePositions ?? mesh.edges?.positions
  const groups = mesh.edgeGroups
  const vertexCount = positions ? Math.floor(positions.length / 3) : 0
  let span: { edgeId: number; start: number; count: number } | null = null

  if (groups && groups.length > 0) {
    const sum = groups.reduce((total, group) => total + group.count, 0)
    const scale =
      vertexCount > 0 &&
      sum === vertexCount / 2 &&
      groups.every((group) => group.start + group.count <= vertexCount / 2)
        ? 2
        : 1
    const group =
      groups.find((item) => item.edgeId === edgeId) ??
      groups.find(
        (item) =>
          vertexIndex >= item.start * scale && vertexIndex < (item.start + item.count) * scale,
      )
    if (group)
      span = { edgeId: group.edgeId, start: group.start * scale, count: group.count * scale }
  }

  if (!span && edgeId !== undefined) {
    const group = groups?.find((item) => item.edgeId === edgeId)
    span = group
      ? { edgeId: group.edgeId, start: group.start, count: group.count }
      : { edgeId, start: Math.max(0, vertexIndex), count: 2 }
  }
  if (!span && Number.isInteger(vertexIndex) && vertexIndex >= 0) {
    span = { edgeId: vertexIndex, start: vertexIndex, count: 2 }
  }
  if (!span) return null

  const ref = positions ? edgeSignature(positions, span.start, span.count) : null
  return { edgeId: span.edgeId, ref }
}

export function serializeEdgeIds(ids: readonly number[]): string {
  return ids.join(',')
}

export function parseEdgeIds(raw: string): number[] {
  if (raw.trim() === '') return []
  const ids: number[] = []
  for (const part of raw.split(',')) {
    const token = part.trim()
    if (!token) continue
    const value = Number(token)
    if (!Number.isInteger(value)) throw new Error('edgeIds must be comma-separated integers')
    ids.push(value)
  }
  return ids
}

export function serializeEdgeRefs(refs: readonly TopologyRef[]): string {
  return JSON.stringify(refs)
}

function readVec(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`edgeRefs ${label} must be xyz`)
  const coords = value.map((item) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new Error(`edgeRefs ${label} must be xyz`)
    }
    return item
  })
  const x = coords[0]
  const y = coords[1]
  const z = coords[2]
  if (x === undefined || y === undefined || z === undefined) {
    throw new Error(`edgeRefs ${label} must be xyz`)
  }
  return [x, y, z]
}

function readRef(value: unknown): TopologyRef {
  if (!value || typeof value !== 'object') throw new Error('edgeRefs must be edge signatures')
  const ref = value as Record<string, unknown>
  if (ref.kind !== 'edge') throw new Error('edgeRefs must be edge signatures')
  if (typeof ref.length !== 'number' || !Number.isFinite(ref.length)) {
    throw new Error('edgeRefs length must be a number')
  }
  return {
    kind: 'edge',
    mid: readVec(ref.mid, 'mid'),
    dir: readVec(ref.dir, 'dir'),
    length: ref.length,
  }
}

export function parseEdgeRefs(raw: string): TopologyRef[] {
  if (raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('edgeRefs must be a JSON array')
  }
  if (!Array.isArray(parsed)) throw new Error('edgeRefs must be a JSON array')
  return parsed.map((item) => readRef(item))
}

export interface EdgeParamUpdate {
  edgeIds: string
  edgeRefs?: string
}

/**
 * Adds one picked edge. Ids stay comma-separated. Refs stay a parallel JSON
 * array, and are dropped when a pick has no signature so the lists cannot drift.
 */
export function mergeEdgeParams(
  edgeIds: unknown,
  edgeRefs: unknown,
  add: EdgePick,
): EdgeParamUpdate {
  const ids = parseEdgeIds(typeof edgeIds === 'string' ? edgeIds : '')
  const refs = typeof edgeRefs === 'string' && edgeRefs.trim() ? parseEdgeRefs(edgeRefs) : []
  if (ids.includes(add.edgeId)) {
    return refs.length > 0
      ? { edgeIds: serializeEdgeIds(ids), edgeRefs: serializeEdgeRefs(refs) }
      : { edgeIds: serializeEdgeIds(ids) }
  }
  const nextIds = [...ids, add.edgeId]
  const stored: EdgeParamUpdate = { edgeIds: serializeEdgeIds(nextIds) }
  const aligned = refs.length === ids.length
  if (add.ref && (ids.length === 0 || aligned)) {
    stored.edgeRefs = serializeEdgeRefs([...refs, add.ref])
  }
  return stored
}
