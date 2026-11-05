import { describe, expect, it } from 'vitest'
import {
  advanceSketch,
  CAMERA_UP,
  DEFAULT_CAMERA_POSITION,
  edgePickThreshold,
  entityAnnotation,
  formatLength,
  gridRotation,
  planeFrame,
  previewPolyline,
  projectRayToPlane,
  snapPoint,
  snapToGrid,
  toWorld,
  viewDirection,
  workPlaneFromNormal,
} from './project.ts'

/** Three's XYZ Euler on a GridHelper point (x, 0, z). */
function rotateGrid(
  x: number,
  z: number,
  rotation: readonly [number, number, number],
): [number, number, number] {
  let y = 0
  const [rx, , rz] = rotation
  if (rx !== 0) {
    const cos = Math.cos(rx)
    const sin = Math.sin(rx)
    const nextY = y * cos - z * sin
    z = y * sin + z * cos
    y = nextY
  }
  if (rz !== 0) {
    const cos = Math.cos(rz)
    const sin = Math.sin(rz)
    const nextX = x * cos - y * sin
    y = x * sin + y * cos
    x = nextX
  }
  return [x, y, z]
}

describe('sketch projection', () => {
  it('snaps to a 1 mm or 5 mm grid', () => {
    expect(snapToGrid(1.4, 1)).toBe(1)
    expect(snapToGrid(1.5, 1)).toBe(2)
    expect(snapToGrid(-2.4, 1)).toBe(-2)
    expect(snapToGrid(7, 5)).toBe(5)
    expect(snapToGrid(7.5, 5)).toBe(10)
    expect(snapPoint([1.2, 8.8], 1)).toEqual([1, 9])
  })

  it('projects a camera ray onto the Z-up floor, right wall, and front wall', () => {
    expect(planeFrame('XY')).toEqual({ u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] })
    expect(planeFrame('YZ')).toEqual({ u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] })
    expect(planeFrame('ZX')).toEqual({ u: [0, 0, 1], v: [1, 0, 0], normal: [0, 1, 0] })

    expect(projectRayToPlane([5, 8, 10], [0, 0, -1], 'XY')).toEqual([5, 8])
    expect(projectRayToPlane([20, 4, 3], [-1, 0, 0], 'YZ')).toEqual([4, 3])
    expect(projectRayToPlane([2, 30, 6], [0, -1, 0], 'ZX')).toEqual([6, 2])
    expect(toWorld('XY', 5, 8)).toEqual([5, 8, 0])
    expect(toWorld('YZ', 4, 3)).toEqual([0, 4, 3])
    expect(toWorld('ZX', 6, 2)).toEqual([2, 0, 6])
  })

  it('keeps XY on the floor and YZ and ZX (the XZ plane) vertical', () => {
    expect(toWorld('XY', 12, -3)).toEqual([12, -3, 0])
    expect(toWorld('YZ', 12, -3)[0]).toBe(0)
    expect(toWorld('ZX', 12, -3)[1]).toBe(0)
    expect(planeFrame('YZ').normal[2]).toBe(0)
    expect(planeFrame('ZX').normal[2]).toBe(0)
    const floor = gridRotation('XY')
    const right = gridRotation('YZ')
    const front = gridRotation('ZX')
    expect(floor[0]).toBeCloseTo(Math.PI / 2)
    expect(floor[1]).toBe(0)
    expect(floor[2]).toBe(0)
    expect(right).toEqual([0, 0, Math.PI / 2])
    expect(front).toEqual([0, 0, 0])
    expect(rotateGrid(10, 4, floor)[2]).toBeCloseTo(0)
    expect(rotateGrid(10, 4, right)[0]).toBeCloseTo(0)
    expect(rotateGrid(10, 4, front)[1]).toBeCloseTo(0)
  })

  it('aims standard views with Z up', () => {
    expect(CAMERA_UP).toEqual([0, 0, 1])
    expect(DEFAULT_CAMERA_POSITION[1]).toBeLessThan(0)
    expect(DEFAULT_CAMERA_POSITION[2]).toBeGreaterThan(0)
    expect(viewDirection('top')).toEqual([0, 0, 1])
    expect(viewDirection('front')).toEqual([0, 1, 0])
    expect(viewDirection('right')).toEqual([1, 0, 0])
    const iso = viewDirection('iso')
    expect(Math.hypot(iso[0], iso[1], iso[2])).toBeCloseTo(1)
    const scale = Math.hypot(1, -1, 0.8)
    expect(iso[0]).toBeCloseTo(1 / scale)
    expect(iso[1]).toBeCloseTo(-1 / scale)
    expect(iso[2]).toBeCloseTo(0.8 / scale)
    expect(viewDirection('top')[2]).toBeGreaterThan(0)
    expect(viewDirection('front')[1]).toBeGreaterThan(0)
    expect(viewDirection('right')[0]).toBeGreaterThan(0)
    const distance = Math.hypot(...DEFAULT_CAMERA_POSITION)
    expect(edgePickThreshold(distance)).toBeGreaterThan(0.45)
    expect(edgePickThreshold(distance * 4)).toBeGreaterThan(edgePickThreshold(distance))
    expect(edgePickThreshold(0)).toBe(0.6)
  })

  it('projects onto a face plane that does not pass through the origin', () => {
    const frame = workPlaneFromNormal([0, 0, 20], [0, 0, 1])
    expect(projectRayToPlane([5, 8, 30], [0, 0, -1], frame)).toEqual([5, 8])
    expect(toWorld(frame, 5, 8)).toEqual([5, 8, 20])
    expect(projectRayToPlane([5, 8, 10], [0, 0, -1], frame)).toBeNull()
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
