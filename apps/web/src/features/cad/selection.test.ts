import { describe, expect, it } from 'vitest'
import {
  boxSelect,
  keepKind,
  mergeSelection,
  rankHits,
  rankedHits,
  toggleSelection,
  type HitCandidate,
  type SelectionItem,
} from './selection.ts'

const hit = (
  kind: HitCandidate['kind'],
  id: number,
  depth: number,
  screenPx = 0,
): HitCandidate => ({ kind, featureId: 'f1', id, depth, screenPx })
const item = (kind: SelectionItem['kind'], id: number): SelectionItem => ({
  kind,
  featureId: 'f1',
  id,
})

describe('rankHits', () => {
  const all = [hit('face', 1, 10), hit('edge', 4, 10, 2), hit('vertex', 2, 10, 3)]
  it('returns only the filtered kind', () => {
    expect(rankHits(all, 'face')?.id).toBe(1)
    expect(rankHits(all, 'edge')?.id).toBe(4)
    expect(rankHits(all, 'vertex')?.id).toBe(2)
  })
  it('rejects edges beyond the pixel threshold', () => {
    expect(rankHits([hit('edge', 1, 5, 9)], 'edge')).toBeNull()
    expect(rankHits([hit('edge', 1, 5, 9)], 'edge', 10)?.id).toBe(1)
  })
  it('prefers the closer edge on screen, then depth, then id', () => {
    expect(rankHits([hit('edge', 1, 5, 4), hit('edge', 2, 9, 1)], 'edge')?.id).toBe(2)
    expect(rankHits([hit('face', 3, 8), hit('face', 2, 4)], 'face')?.id).toBe(2)
    expect(rankHits([hit('face', 5, 4), hit('face', 2, 4)], 'face')?.id).toBe(2)
  })
  it('ranks all eligible edges and includes the pixel boundary', () => {
    expect(rankHits([hit('edge', 1, 1, 7), hit('edge', 2, 4, 6)], 'edge')?.id).toBe(2)
    expect(rankHits([hit('edge', 3, 8, 2), hit('edge', 4, 3, 2)], 'edge')?.id).toBe(4)
  })
  it('orders distinct eligible candidates for cycling', () => {
    const candidates = [
      hit('edge', 1, 4, 3),
      hit('edge', 2, 8, 1),
      hit('edge', 1, 3, 2),
      hit('edge', 3, 1, 9),
      hit('face', 4, 1),
    ]
    expect(rankedHits(candidates, 'edge').map((entry) => entry.id)).toEqual([2, 1])
  })
  it('returns null when nothing matches', () => {
    expect(rankHits([hit('face', 1, 1)], 'edge')).toBeNull()
    expect(rankHits([], 'face')).toBeNull()
  })
})

describe('toggleSelection', () => {
  it('replaces on plain click and clears on empty click', () => {
    expect(toggleSelection([item('face', 1)], item('face', 2), false)).toEqual([item('face', 2)])
    expect(toggleSelection([item('face', 1)], null, false)).toEqual([])
  })
  it('toggles on additive click and keeps set on empty additive click', () => {
    const one = toggleSelection([], item('edge', 1), true)
    const two = toggleSelection(one, item('edge', 2), true)
    expect(two).toHaveLength(2)
    expect(toggleSelection(two, item('edge', 1), true)).toEqual([item('edge', 2)])
    expect(toggleSelection(two, null, true)).toEqual(two)
  })
})

describe('filters and box select', () => {
  it('keepKind drops other kinds', () => {
    expect(keepKind([item('face', 1), item('edge', 1)], 'edge')).toEqual([item('edge', 1)])
  })
  it('boxSelect picks filtered centers inside the rect, either drag direction', () => {
    const centers = [
      { ...item('edge', 1), x: 10, y: 10 },
      { ...item('edge', 2), x: 90, y: 90 },
      { ...item('face', 3), x: 20, y: 20 },
    ]
    expect(boxSelect(centers, { x0: 50, y0: 50, x1: 0, y1: 0 }, 'edge')).toEqual([item('edge', 1)])
  })
  it('mergeSelection skips duplicates', () => {
    expect(mergeSelection([item('edge', 1)], [item('edge', 1), item('edge', 2)])).toHaveLength(2)
  })
})
