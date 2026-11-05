import { BoxGeometry } from 'three'
import type { BufferAttribute, InterleavedBufferAttribute } from 'three'
import type { CadFeature, ParamValue } from './model/CadDocument.ts'

/**
 * One face inside a triangle mesh.
 * `start` and `count` count entries in the index buffer (3 per triangle).
 * If the counts instead add up to the triangle count, they are triangle ranges.
 */
export interface FaceGroup {
  start: number
  count: number
  faceId: number
}

/**
 * One edge inside `edgePositions`.
 * `start` and `count` count vertices. A segment range is accepted when the
 * counts add up to the segment count instead.
 */
export interface EdgeGroup {
  start: number
  count: number
  edgeId: number
}

/** Triangle buffers the viewport draws with a standard material. */
export interface MeshBuffers {
  id: string
  positions: Float32Array
  normals?: Float32Array
  indices?: Uint32Array
  faceGroups?: FaceGroup[]
  edgeGroups?: EdgeGroup[]
  /** xyz triples from the kernel edge mesh. */
  edgePositions?: Float32Array
  /** Alias used by GeometryKernel ShapeResult.mesh. Prefer edgePositions in the viewport. */
  edges?: { positions: Float32Array }
}

function groupSpace(
  groups: readonly { start: number; count: number }[],
  indexCount: number,
): 'index' | 'triangle' {
  const sum = groups.reduce((total, group) => total + group.count, 0)
  if (indexCount > 0 && sum === indexCount / 3) return 'triangle'
  return 'index'
}

/** Face under a three.js triangle index, using `faceGroups` when the mesh has them. */
export function faceAt(
  groups: readonly FaceGroup[] | undefined,
  triangleIndex: number,
  indexCount: number,
): { faceId: number; triangles: { start: number; count: number }[] } | null {
  if (!groups?.length || triangleIndex < 0 || !Number.isFinite(triangleIndex)) return null
  const space = groupSpace(groups, indexCount)
  const pos = space === 'index' ? triangleIndex * 3 : triangleIndex
  const hit = groups.find((group) => pos >= group.start && pos < group.start + group.count)
  if (!hit) return null
  const triangles = groups
    .filter((group) => group.faceId === hit.faceId)
    .map((group) =>
      space === 'index'
        ? { start: group.start / 3, count: group.count / 3 }
        : { start: group.start, count: group.count },
    )
  return { faceId: hit.faceId, triangles }
}

/**
 * Edge under a line-segment hit. `vertexIndex` is the segment's first vertex
 * (0, 2, 4, …), which is what three.js reports for `LineSegments`.
 */
export function edgeAt(
  groups: readonly EdgeGroup[] | undefined,
  vertexIndex: number,
  vertexCount: number,
): { edgeId: number; start: number; count: number } | null {
  if (!groups?.length || vertexIndex < 0 || !Number.isFinite(vertexIndex)) return null
  const byVertex = groups.find(
    (group) => vertexIndex >= group.start && vertexIndex < group.start + group.count,
  )
  if (byVertex) return { edgeId: byVertex.edgeId, start: byVertex.start, count: byVertex.count }
  const segmentCount = vertexCount / 2
  const sum = groups.reduce((total, group) => total + group.count, 0)
  if (!(segmentCount > 0) || sum !== segmentCount) return null
  const segment = vertexIndex / 2
  const bySegment = groups.find(
    (group) => segment >= group.start && segment < group.start + group.count,
  )
  if (!bySegment) return null
  return { edgeId: bySegment.edgeId, start: bySegment.start * 2, count: bySegment.count * 2 }
}

function num(value: ParamValue | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function copyAttr(
  attr: BufferAttribute | InterleavedBufferAttribute | undefined,
): Float32Array | null {
  if (!attr) return null
  return new Float32Array(attr.array)
}

/**
 * Dead local preview. The pane displays GeometryKernel meshes, not this box.
 * Kept so older unit tests can still build a BoxGeometry buffer.
 */
export function meshForFeature(feature: CadFeature): MeshBuffers | null {
  if (feature.suppressed || feature.kind !== 'box') return null
  const width = Math.max(num(feature.params.width, 20), 0.001)
  const height = Math.max(num(feature.params.height, 20), 0.001)
  const depth = Math.max(num(feature.params.depth, 20), 0.001)
  const geometry = new BoxGeometry(width, height, depth)
  geometry.translate(
    num(feature.params.x, 0),
    num(feature.params.y, height / 2),
    num(feature.params.z, 0),
  )
  const positions = copyAttr(geometry.getAttribute('position'))
  const normals = copyAttr(geometry.getAttribute('normal'))
  const index = geometry.getIndex()
  const indices = index ? new Uint32Array(index.array) : undefined
  const faceGroups = geometry.groups.map((group) => ({
    start: group.start,
    count: group.count,
    faceId: group.materialIndex ?? 0,
  }))
  geometry.dispose()
  if (!positions) return null
  return {
    id: feature.id,
    positions,
    normals: normals ?? undefined,
    indices,
    faceGroups: faceGroups.length > 0 ? faceGroups : undefined,
  }
}

/** First triangle of a face, so a stored faceId can be turned back into a highlight. */
export function faceTriangle(
  groups: readonly FaceGroup[] | undefined,
  faceId: number,
  indexCount: number,
): number | null {
  if (!groups?.length) return null
  const group = groups.find((item) => item.faceId === faceId)
  if (!group) return null
  return groupSpace(groups, indexCount) === 'index' ? Math.floor(group.start / 3) : group.start
}
