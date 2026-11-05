import { describe, expect, it } from 'vitest'
import { planeFromFace } from './facePlane.ts'
import { projectRayToPlane, toWorld, workPlaneFromNormal } from './project.ts'

function quad(
  corners: Array<[number, number, number]>,
  normal: [number, number, number],
): {
  positions: number[]
  indices: number[]
  normals: number[]
  triangles: { start: number; count: number }[]
} {
  const positions = corners.flat()
  const normals = corners.flatMap(() => normal)
  return {
    positions,
    indices: [0, 1, 2, 0, 2, 3],
    normals,
    triangles: [{ start: 0, count: 2 }],
  }
}

function dot(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0)
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ]
}

describe('face sketch planes', () => {
  it('reuses XY, YZ, and ZX when the face lies on that datum', () => {
    expect(
      planeFromFace(
        quad(
          [
            [0, 0, 0],
            [10, 0, 0],
            [10, 10, 0],
            [0, 10, 0],
          ],
          [0, 0, 1],
        ),
      ),
    ).toEqual({ kind: 'named', plane: 'XY' })

    expect(
      planeFromFace(
        quad(
          [
            [0, 0, 0],
            [0, 10, 0],
            [0, 10, 10],
            [0, 0, 10],
          ],
          [1, 0, 0],
        ),
      ),
    ).toEqual({ kind: 'named', plane: 'YZ' })

    expect(
      planeFromFace(
        quad(
          [
            [0, 0, 0],
            [0, 0, 10],
            [10, 0, 10],
            [10, 0, 0],
          ],
          [0, 1, 0],
        ),
      ),
    ).toEqual({ kind: 'named', plane: 'ZX' })

    const floor = quad(
      [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      [0, 0, -1],
    )
    floor.indices = [0, 2, 1, 0, 3, 2]
    expect(planeFromFace(floor)).toEqual({ kind: 'named', plane: 'XY' })
  })

  it('stores origin and normal for an offset or tilted face', () => {
    const offset = planeFromFace(
      quad(
        [
          [0, 0, 20],
          [10, 0, 20],
          [10, 10, 20],
          [0, 10, 20],
        ],
        [0, 0, 1],
      ),
    )
    expect(offset?.kind).toBe('frame')
    if (offset?.kind !== 'frame') return
    expect(offset.plane).toBe('XY')
    expect(offset.origin).toEqual([5, 5, 20])
    expect(offset.normal[2]).toBeCloseTo(1)
    expect(offset.u[0]).toBeCloseTo(1)
    expect(offset.v[1]).toBeCloseTo(1)
    expect(dot(cross(offset.u, offset.v), offset.normal)).toBeCloseTo(1)

    const frame = workPlaneFromNormal(offset.origin, offset.normal)
    expect(projectRayToPlane([5, 8, 30], [0, 0, -1], frame)).toEqual([0, 3])
    expect(toWorld(frame, 0, 3)).toEqual([5, 8, 20])

    const tilted = planeFromFace({
      positions: [0, 0, 0, 4, 0, 0, 0, 2, 2],
      indices: [0, 1, 2],
      triangles: [{ start: 0, count: 1 }],
    })
    expect(tilted?.kind).toBe('frame')
    if (tilted?.kind !== 'frame') return
    expect(['XY', 'YZ', 'ZX']).toContain(tilted.plane)
    expect(Math.abs(tilted.normal[0])).toBeLessThan(0.2)
    expect(dot(cross(tilted.u, tilted.v), tilted.normal)).toBeCloseTo(1)
  })
})
