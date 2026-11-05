import type {
  EdgeGroup,
  EdgeTopologyRef,
  FaceGroup,
  FaceTopologyRef,
  MeshBuffer,
  TopologyRef,
} from './types'

/** An edge on a mesh, already reduced to the same signature as `EdgeTopologyRef`. */
export interface EdgeCandidate {
  edgeId: number
  mid: [number, number, number]
  dir: [number, number, number]
  length: number
}

/** A face on a mesh, reduced to a centroid and an outward normal. */
export interface FaceCandidate {
  faceId: number
  origin: [number, number, number]
  normal: [number, number, number]
}

type Vec3 = [number, number, number]

/** Storage precision for topology signatures. One hundredth of a millimetre. */
export const TOPOLOGY_ROUND_MM = 0.01

/**
 * How far a stored signature may sit from a candidate and still be the same
 * edge. This covers rounding, not a real move of the edge.
 */
const MATCH_TOL_MM = 0.02

const DIR_DOT = 0.995

export function roundMm(value: number): number {
  return Math.round(value / TOPOLOGY_ROUND_MM) * TOPOLOGY_ROUND_MM
}

function roundVec(value: Vec3): Vec3 {
  return [roundMm(value[0]), roundMm(value[1]), roundMm(value[2])]
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function vertex(positions: ArrayLike<number>, index: number): Vec3 | null {
  const x = positions[index * 3]
  const y = positions[index * 3 + 1]
  const z = positions[index * 3 + 2]
  if (x === undefined || y === undefined || z === undefined) return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return [x, y, z]
}

/** Opposite directions describe the same undirected edge. */
function canonicalDir(dir: Vec3): Vec3 | null {
  const length = Math.hypot(dir[0], dir[1], dir[2])
  if (length <= 1e-12) return null
  let x = dir[0] / length
  let y = dir[1] / length
  let z = dir[2] / length
  if (x < -1e-9 || (Math.abs(x) <= 1e-9 && (y < -1e-9 || (Math.abs(y) <= 1e-9 && z < 0)))) {
    x = -x
    y = -y
    z = -z
  }
  return roundVec([x, y, z])
}

function unitDir(dir: Vec3): Vec3 | null {
  const length = Math.hypot(dir[0], dir[1], dir[2])
  if (length <= 1e-12) return null
  return roundVec([dir[0] / length, dir[1] / length, dir[2] / length])
}

function metricsOf(
  positions: ArrayLike<number>,
  start: number,
  count: number,
): { mid: Vec3; dir: Vec3; length: number } | null {
  if (count < 2 || start < 0) return null
  const points: Vec3[] = []
  for (let index = start; index < start + count; index += 1) {
    const point = vertex(positions, index)
    if (!point) return null
    const previous = points[points.length - 1]
    if (previous && dist(previous, point) <= 1e-9) continue
    points.push(point)
  }
  if (points.length < 2) return null

  let length = 0
  const spans: number[] = []
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    if (!from || !to) return null
    const span = dist(from, to)
    spans.push(span)
    length += span
  }
  if (length <= 1e-9) return null

  const half = length / 2
  let walked = 0
  let mid: Vec3 = points[0] ?? [0, 0, 0]
  for (let index = 1; index < points.length; index += 1) {
    const span = spans[index - 1] ?? 0
    const from = points[index - 1]
    const to = points[index]
    if (!from || !to) return null
    if (walked + span >= half || index === points.length - 1) {
      const t = span <= 1e-12 ? 0 : Math.min(1, Math.max(0, (half - walked) / span))
      mid = lerp(from, to, t)
      break
    }
    walked += span
  }

  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return null
  let dir = sub(last, first)
  if (Math.hypot(dir[0], dir[1], dir[2]) <= 1e-9) {
    let longest = 0
    dir = [0, 0, 0]
    for (let index = 1; index < points.length; index += 1) {
      const span = spans[index - 1] ?? 0
      const from = points[index - 1]
      const to = points[index]
      if (!from || !to || span <= longest) continue
      longest = span
      dir = sub(to, from)
    }
  }
  const prepared = canonicalDir(dir)
  if (!prepared) return null
  return { mid: roundVec(mid), dir: prepared, length: roundMm(length) }
}

/** Signature for one edge group. `start` and `count` are vertex indexes. */
export function edgeRefFromMesh(mesh: MeshBuffer, group: EdgeGroup): EdgeTopologyRef | null {
  const positions = mesh.edges?.positions
  if (!positions) return null
  const metrics = metricsOf(positions, group.start, group.count)
  if (!metrics) return null
  return { kind: 'edge', mid: metrics.mid, dir: metrics.dir, length: metrics.length }
}

export function edgeCandidatesFromMesh(mesh: MeshBuffer): EdgeCandidate[] {
  const candidates: EdgeCandidate[] = []
  for (const group of mesh.edgeGroups ?? []) {
    const ref = edgeRefFromMesh(mesh, group)
    if (!ref) continue
    candidates.push({ edgeId: group.edgeId, mid: ref.mid, dir: ref.dir, length: ref.length })
  }
  return candidates
}

function preparedEdge(ref: {
  mid: Vec3
  dir: Vec3
  length: number
}): { mid: Vec3; dir: Vec3; length: number } | null {
  const dir = canonicalDir(ref.dir)
  if (!dir || !Number.isFinite(ref.length) || ref.length <= 0) return null
  return { mid: roundVec(ref.mid), dir, length: roundMm(ref.length) }
}

function dirsMatch(a: Vec3, b: Vec3): boolean {
  const close =
    Math.abs(a[0] - b[0]) <= MATCH_TOL_MM &&
    Math.abs(a[1] - b[1]) <= MATCH_TOL_MM &&
    Math.abs(a[2] - b[2]) <= MATCH_TOL_MM
  if (close) return true
  const aLen = Math.hypot(a[0], a[1], a[2])
  const bLen = Math.hypot(b[0], b[1], b[2])
  if (aLen <= 1e-9 || bLen <= 1e-9) return false
  const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (aLen * bLen)
  return dot >= DIR_DOT
}

function edgesMatch(
  ref: { mid: Vec3; dir: Vec3; length: number },
  candidate: { mid: Vec3; dir: Vec3; length: number },
): boolean {
  if (Math.abs(ref.length - candidate.length) > MATCH_TOL_MM) return false
  if (dist(ref.mid, candidate.mid) > MATCH_TOL_MM) return false
  return dirsMatch(ref.dir, candidate.dir)
}

/**
 * Picks one current edge hash per stored signature.
 * Returns `{ error }` when a signature is missing or two edges fit it equally.
 * It never means "use every edge".
 */
export function matchEdgeRefs(
  refs: readonly TopologyRef[],
  candidates: readonly EdgeCandidate[],
): number[] | { error: string } {
  if (refs.length === 0) return { error: 'no topology refs to match' }
  const ids: number[] = []
  const used = new Set<number>()
  for (const ref of refs) {
    if (ref.kind !== 'edge') return { error: 'topology ref is not an edge' }
    const wanted = preparedEdge(ref)
    if (!wanted) return { error: 'edge ref has no direction' }
    const hits: { edgeId: number; score: number }[] = []
    for (const candidate of candidates) {
      if (used.has(candidate.edgeId)) continue
      const prepared = preparedEdge(candidate)
      if (!prepared || !edgesMatch(wanted, prepared)) continue
      hits.push({
        edgeId: candidate.edgeId,
        score: dist(wanted.mid, prepared.mid) + Math.abs(wanted.length - prepared.length),
      })
    }
    hits.sort((a, b) => a.score - b.score)
    const best = hits[0]
    const next = hits[1]
    if (!best) return { error: 'no edge matched the stored signature' }
    if (next && next.score - best.score <= 1e-9) return { error: 'edge match is ambiguous' }
    used.add(best.edgeId)
    ids.push(best.edgeId)
  }
  return ids
}

function faceSpace(groups: readonly FaceGroup[], indexCount: number): 'triangle' | 'index' {
  const sum = groups.reduce((total, group) => total + group.count, 0)
  if (indexCount > 0 && sum === indexCount / 3) return 'triangle'
  return 'index'
}

function corner(mesh: MeshBuffer, triangle: number, slot: number): Vec3 | null {
  const index = mesh.indices[triangle * 3 + slot]
  if (index === undefined) return null
  return vertex(mesh.positions, index)
}

function faceSignature(
  mesh: MeshBuffer,
  group: FaceGroup,
  space: 'triangle' | 'index',
): { origin: Vec3; normal: Vec3 } | null {
  const triStart = space === 'index' ? group.start / 3 : group.start
  const triCount = space === 'index' ? group.count / 3 : group.count
  const first = Math.round(triStart)
  const count = Math.round(triCount)
  if (count <= 0) return null

  let areaSum = 0
  let cx = 0
  let cy = 0
  let cz = 0
  let nx = 0
  let ny = 0
  let nz = 0
  for (let triangle = first; triangle < first + count; triangle += 1) {
    const a = corner(mesh, triangle, 0)
    const b = corner(mesh, triangle, 1)
    const c = corner(mesh, triangle, 2)
    if (!a || !b || !c) continue
    const ab = sub(b, a)
    const ac = sub(c, a)
    const cross: Vec3 = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ]
    const area = Math.hypot(cross[0], cross[1], cross[2]) * 0.5
    if (area <= 1e-12) continue
    areaSum += area
    cx += ((a[0] + b[0] + c[0]) / 3) * area
    cy += ((a[1] + b[1] + c[1]) / 3) * area
    cz += ((a[2] + b[2] + c[2]) / 3) * area
    nx += cross[0]
    ny += cross[1]
    nz += cross[2]
  }
  if (areaSum <= 1e-12) return null
  const normal = unitDir([nx, ny, nz])
  if (!normal) return null
  return { origin: roundVec([cx / areaSum, cy / areaSum, cz / areaSum]), normal }
}

export function faceCandidatesFromMesh(mesh: MeshBuffer): FaceCandidate[] {
  const groups = mesh.faceGroups
  if (!groups || groups.length === 0) return []
  const space = faceSpace(groups, mesh.indices.length)
  const candidates: FaceCandidate[] = []
  for (const group of groups) {
    const signature = faceSignature(mesh, group, space)
    if (!signature) continue
    candidates.push({ faceId: group.faceId, origin: signature.origin, normal: signature.normal })
  }
  return candidates
}

function preparedFace(ref: { origin: Vec3; normal: Vec3 }): { origin: Vec3; normal: Vec3 } | null {
  const normal = unitDir(ref.normal)
  if (!normal) return null
  return { origin: roundVec(ref.origin), normal }
}

/** Picks one current face hash per stored face signature. */
export function matchFaceRefs(
  refs: readonly FaceTopologyRef[],
  candidates: readonly FaceCandidate[],
): number[] | { error: string } {
  if (refs.length === 0) return { error: 'no topology refs to match' }
  const ids: number[] = []
  const used = new Set<number>()
  for (const ref of refs) {
    if (ref.kind !== 'face') return { error: 'topology ref is not a face' }
    const wanted = preparedFace(ref)
    if (!wanted) return { error: 'face ref has no normal' }
    const hits: { faceId: number; score: number }[] = []
    for (const candidate of candidates) {
      if (used.has(candidate.faceId)) continue
      const prepared = preparedFace(candidate)
      if (!prepared) continue
      if (dist(wanted.origin, prepared.origin) > MATCH_TOL_MM) continue
      if (!dirsMatch(wanted.normal, prepared.normal)) continue
      hits.push({
        faceId: candidate.faceId,
        score: dist(wanted.origin, prepared.origin),
      })
    }
    hits.sort((a, b) => a.score - b.score)
    const best = hits[0]
    const next = hits[1]
    if (!best) return { error: 'no face matched the stored signature' }
    if (next && next.score - best.score <= 1e-9) return { error: 'face match is ambiguous' }
    used.add(best.faceId)
    ids.push(best.faceId)
  }
  return ids
}
