import { describe, expect, it } from 'vitest'
import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three'
import { computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import { emptyDocument, makeBoxFeature } from './model/CadDocument.ts'
import { edgeAt, faceAt, meshForFeature } from './solids.ts'

describe('meshForFeature', () => {
  it('builds a box buffer from BoxGeometry', () => {
    const feature = makeBoxFeature(emptyDocument(), 'box')
    const mesh = meshForFeature(feature)
    expect(mesh?.id).toBe('box')
    expect(mesh && mesh.positions.length).toBeGreaterThan(0)
    expect(mesh?.normals?.length).toBe(mesh?.positions.length)
    expect(mesh?.indices && mesh.indices.length).toBeGreaterThan(0)
  })

  it('skips suppressed and non-box features', () => {
    const feature = makeBoxFeature(emptyDocument(), 'box')
    expect(meshForFeature({ ...feature, suppressed: true })).toBeNull()
    expect(meshForFeature({ ...feature, kind: 'fillet' })).toBeNull()
  })

  it('tags each box face so a triangle maps back to a face id', () => {
    const mesh = meshForFeature(makeBoxFeature(emptyDocument(), 'box'))
    expect(mesh?.faceGroups).toHaveLength(6)
    const indexCount = mesh?.indices?.length ?? 0
    expect(faceAt(mesh?.faceGroups, 0, indexCount)?.faceId).toBe(0)
    expect(faceAt(mesh?.faceGroups, 2, indexCount)?.faceId).toBe(1)
    expect(faceAt(mesh?.faceGroups, 99, indexCount)).toBeNull()
  })

  it('reads an edge id from a vertex range or a segment range', () => {
    expect(edgeAt([{ start: 0, count: 4, edgeId: 7 }], 2, 8)).toEqual({
      edgeId: 7,
      start: 0,
      count: 4,
    })
    expect(
      edgeAt(
        [
          { start: 0, count: 1, edgeId: 1 },
          { start: 1, count: 1, edgeId: 3 },
        ],
        2,
        4,
      ),
    ).toEqual({
      edgeId: 3,
      start: 2,
      count: 2,
    })
    expect(edgeAt([{ start: 4, count: 2, edgeId: 1 }], 0, 6)).toBeNull()
  })

  it('builds an indirect bounds tree without reordering the index', () => {
    const mesh = meshForFeature(makeBoxFeature(emptyDocument(), 'box'))
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(mesh!.positions, 3))
    geometry.setIndex(new BufferAttribute(mesh!.indices!, 1))
    const before = Array.from(geometry.index!.array)
    computeBoundsTree.call(geometry, { indirect: true })
    expect(Array.from(geometry.index!.array)).toEqual(before)
    expect(geometry.boundsTree).toBeTruthy()
    disposeBoundsTree.call(geometry)
    geometry.dispose()
  })
})
