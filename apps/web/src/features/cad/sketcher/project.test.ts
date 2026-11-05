import { describe, expect, it } from 'vitest'
import {
  advanceSketch,
  entityAnnotation,
  formatLength,
  previewPolyline,
  projectRayToPlane,
  snapPoint,
  snapToGrid,
  toWorld,
} from './project.ts'

describe('sketch projection', () => {
  it('snaps to a 1 mm or 5 mm grid', () => {
    expect(snapToGrid(1.4, 1)).toBe(1)
    expect(snapToGrid(1.5, 1)).toBe(2)
    expect(snapToGrid(-2.4, 1)).toBe(-2)
    expect(snapToGrid(7, 5)).toBe(5)
    expect(snapToGrid(7.5, 5)).toBe(10)
    expect(snapPoint([1.2, 8.8], 1)).toEqual([1, 9])
  })

  it('projects a camera ray onto XY, YZ, and ZX', () => {
    expect(projectRayToPlane([5, 8, 10], [0, 0, -1], 'XY')).toEqual([5, 8])
    expect(projectRayToPlane([20, 4, -3], [-1, 0, 0], 'YZ')).toEqual([3, 4])
    expect(projectRayToPlane([6, 30, -2], [0, -1, 0], 'ZX')).toEqual([6, 2])
    expect(toWorld('XY', 5, 8)).toEqual([5, 8, 0])
    expect(toWorld('YZ', 3, 4)).toEqual([0, 4, -3])
    expect(toWorld('ZX', 6, 2)).toEqual([6, 0, -2])
  })

  it('misses a parallel ray and a ray aimed away from the plane', () => {
    expect(projectRayToPlane([0, 0, 10], [1, 0, 0], 'XY')).toBeNull()
    expect(projectRayToPlane([0, 0, -10], [0, 0, -1], 'XY')).toBeNull()
  })

  it('round-trips a snapped sketch point through the plane', () => {
    const sketch = snapPoint([10.2, -3.6], 1)
    const world = toWorld('ZX', sketch[0], sketch[1])
    const back = projectRayToPlane([world[0], world[1] + 40, world[2]], [0, -1, 0], 'ZX')
    expect(back).toEqual(sketch)
  })

  it('shows a line length and a circle radius', () => {
    expect(formatLength(12)).toBe('12')
    expect(formatLength(12.04)).toBe('12')
    expect(formatLength(12.06)).toBe('12.1')
    const line = advanceSketch('line', [[0, 0]], [3, 4], 'e1')
    expect(line.entity && entityAnnotation(line.entity)).toEqual({ text: '5', at: [1.5, 2] })
    const circle = advanceSketch('circle', [[1, 2]], [1, 6], 'e2')
    expect(circle.entity && entityAnnotation(circle.entity)?.text).toBe('R 4')
  })

  it('rubber-bands a rectangle and chains a line', () => {
    expect(previewPolyline('rectangle', [[0, 0]], [10, 4])).toEqual([
      [0, 0],
      [10, 0],
      [10, 4],
      [0, 4],
      [0, 0],
    ])
    const first = advanceSketch('line', [], [0, 0], 'e1')
    expect(first.entity).toBeNull()
    const second = advanceSketch('line', first.placed, [4, 0], 'e2')
    expect(second.entity).toMatchObject({ kind: 'line', x1: 0, y1: 0, x2: 4, y2: 0 })
    expect(second.placed).toEqual([[4, 0]])
  })

  it('builds an arc from center, start, and end', () => {
    const center = advanceSketch('arc', [], [0, 0], 'e1')
    const start = advanceSketch('arc', center.placed, [2, 0], 'e1')
    const arc = advanceSketch('arc', start.placed, [0, 2], 'e1')
    expect(arc.entity).toMatchObject({ kind: 'arc', cx: 0, cy: 0, radius: 2 })
    expect(arc.placed).toEqual([])
  })
})
