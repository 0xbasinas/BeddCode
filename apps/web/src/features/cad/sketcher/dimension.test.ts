import { describe, expect, it } from 'vitest'
import { applyDimensionToEntity, commitLiveDimension, parseDimensionText } from './dimension.ts'
import type { SketchEntity } from './types.ts'

describe('dimension parse and apply', () => {
  it('parses a length, a pair, and a radius', () => {
    expect(parseDimensionText('12')).toEqual([12])
    expect(parseDimensionText('12.5')).toEqual([12.5])
    expect(parseDimensionText('40, 25')).toEqual([40, 25])
    expect(parseDimensionText('40 x 25')).toEqual([40, 25])
    expect(parseDimensionText('40×25')).toEqual([40, 25])
    expect(parseDimensionText('R 4')).toEqual([4])
    expect(parseDimensionText('R4')).toEqual([4])
    expect(parseDimensionText('')).toBeNull()
    expect(parseDimensionText('abc')).toBeNull()
    expect(parseDimensionText('12a')).toBeNull()
  })

  it('commits a line length along the cursor and advances the chain', () => {
    const next = commitLiveDimension('line', [[0, 0]], [3, 4], '10', 'e1')
    expect(next).toEqual({
      placed: [[6, 8]],
      entity: { id: 'e1', kind: 'line', x1: 0, y1: 0, x2: 6, y2: 8 },
    })
    expect(commitLiveDimension('line', [[0, 0]], [3, 4], '-5', 'e1')).toBeNull()
    expect(commitLiveDimension('line', [], [3, 4], '10', 'e1')).toBeNull()
  })

  it('commits a rectangle from a pair and a circle from a radius', () => {
    const rect = commitLiveDimension('rectangle', [[1, 2]], [4, 8], '40, 25', 'e2')
    expect(rect?.placed).toEqual([])
    expect(rect?.entity).toMatchObject({ kind: 'rect', x: 1, y: 2, width: 40, height: 25 })

    const square = commitLiveDimension('rectangle', [[0, 0]], [0, 0], '8', 'e3')
    expect(square?.entity).toMatchObject({ kind: 'rect', x: 0, y: 0, width: 8, height: 8 })

    const left = commitLiveDimension('rectangle', [[10, 10]], [4, 6], '6 x 3', 'e4')
    expect(left?.entity).toMatchObject({ kind: 'rect', x: 4, y: 7, width: 6, height: 3 })

    const circle = commitLiveDimension('circle', [[1, 2]], [1, 6], 'R 4', 'e5')
    expect(circle).toEqual({
      placed: [],
      entity: { id: 'e5', kind: 'circle', cx: 1, cy: 2, radius: 4 },
    })
  })

  it('updates an existing line, rectangle, and circle', () => {
    const line: SketchEntity = { id: 'l', kind: 'line', x1: 0, y1: 0, x2: 3, y2: 4 }
    expect(applyDimensionToEntity(line, '10')).toMatchObject({ x1: 0, y1: 0, x2: 6, y2: 8 })

    const rect: SketchEntity = { id: 'r', kind: 'rect', x: 1, y: 2, width: 10, height: 4 }
    expect(applyDimensionToEntity(rect, '40 × 25')).toMatchObject({
      x: 1,
      y: 2,
      width: 40,
      height: 25,
    })
    expect(applyDimensionToEntity(rect, '12')).toMatchObject({ width: 12, height: 4 })

    const circle: SketchEntity = { id: 'c', kind: 'circle', cx: 1, cy: 2, radius: 3 }
    expect(applyDimensionToEntity(circle, 'R 8')).toMatchObject({ cx: 1, cy: 2, radius: 8 })
    expect(applyDimensionToEntity(circle, 'nope')).toBeNull()
  })
})
