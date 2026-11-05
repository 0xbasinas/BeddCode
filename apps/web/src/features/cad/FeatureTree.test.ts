import { describe, expect, it } from 'vitest'
import { featureDetail } from './FeatureTree.tsx'
import type { CadFeature } from './model/CadDocument.ts'

function feature(partial: Partial<CadFeature> & Pick<CadFeature, 'kind'>): CadFeature {
  return {
    id: 'f',
    name: 'Feature',
    suppressed: false,
    params: {},
    ...partial,
  }
}

describe('feature detail', () => {
  it('shows a hole with its diameter', () => {
    expect(featureDetail(feature({ kind: 'hole', name: 'Hole 1', params: { diameter: 8 } }))).toBe(
      'Hole · ⌀8',
    )
    expect(featureDetail(feature({ kind: 'hole', params: {} }))).toBe('Hole')
    expect(featureDetail(feature({ kind: 'fillet' }))).toBe('fillet')
    expect(
      featureDetail(feature({ kind: 'hole', params: { diameter: 8 } }), 'hole depth is missing'),
    ).toBe('Hole · ⌀8 · hole depth is missing')
    expect(featureDetail(feature({ kind: 'fillet' }), 'fillet edges not found')).toBe(
      'fillet · fillet edges not found',
    )
  })
})
