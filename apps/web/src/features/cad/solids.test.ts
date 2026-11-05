import { describe, expect, it } from 'vitest'
import { emptyDocument, makeBoxFeature } from './model/CadDocument.ts'
import { meshForFeature } from './solids.ts'

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
})
