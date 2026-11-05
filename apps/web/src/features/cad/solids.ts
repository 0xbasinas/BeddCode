import { BoxGeometry } from 'three'
import type { BufferAttribute, InterleavedBufferAttribute } from 'three'
import type { CadFeature, ParamValue } from './model/CadDocument.ts'

/** Triangle buffers the viewport draws with a standard material. */
export interface MeshBuffers {
  id: string
  positions: Float32Array
  normals?: Float32Array
  indices?: Uint32Array
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
 * A local preview mesh for features the pane can show without the geometry kernel.
 * Only boxes are built here, from three.js `BoxGeometry`.
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
  geometry.dispose()
  if (!positions) return null
  return { id: feature.id, positions, normals: normals ?? undefined, indices }
}
