import { describe, expect, it } from 'vitest'
import {
  DATUM_PLANES,
  PLANE_LABELS,
  planeCorners,
  planeLabelAt,
  planePlacements,
  visiblePlanes,
} from './planes.ts'

describe('planePlacements', () => {
  it('gives one placement per datum plane', () => {
    expect(planePlacements().map((place) => place.id)).toEqual([...DATUM_PLANES])
  })

  it('points each normal along its own axis', () => {
    const byId = new Map(planePlacements().map((place) => [place.id, place]))
    expect(byId.get('XY')?.normal).toEqual([0, 0, 1])
    expect(byId.get('YZ')?.normal).toEqual([1, 0, 0])
    expect(byId.get('ZX')?.normal).toEqual([0, 1, 0])
  })

  it('keeps u and v perpendicular to the normal', () => {
    for (const place of planePlacements()) {
      const dotU =
        place.u[0] * place.normal[0] +
        place.u[1] * place.normal[1] +
        place.u[2] * place.normal[2]
      const dotV =
        place.v[0] * place.normal[0] +
        place.v[1] * place.normal[1] +
        place.v[2] * place.normal[2]
      expect(dotU).toBeCloseTo(0, 9)
      expect(dotV).toBeCloseTo(0, 9)
    }
  })

  it('honours the half extent', () => {
    const xy = planePlacements(10).find((place) => place.id === 'XY')
    expect(xy?.u).toEqual([10, 0, 0])
    expect(xy?.v).toEqual([0, 10, 0])
  })

  it('labels each plane with its own name', () => {
    for (const place of planePlacements()) {
      expect(place.label).toBe(PLANE_LABELS[place.id])
    }
  })
})

describe('planeCorners', () => {
  it('returns four corners as a closed rectangle', () => {
    const place = planePlacements(10)[0]
    if (!place) throw new Error('expected a placement')
    const corners = planeCorners(place)
    expect(corners).toHaveLength(4)
    // Opposite corners are mirror images through the origin.
    const [a, , c] = corners
    if (!a || !c) throw new Error('expected corners')
    expect(c[0]).toBeCloseTo(-a[0], 9)
    expect(c[1]).toBeCloseTo(-a[1], 9)
    expect(c[2]).toBeCloseTo(-a[2], 9)
  })

  it('spans twice the half extent on each side', () => {
    const place = planePlacements(5).find((entry) => entry.id === 'XY')
    if (!place) throw new Error('expected XY')
    const xs = planeCorners(place).map((corner) => corner[0])
    expect(Math.max(...xs)).toBe(5)
    expect(Math.min(...xs)).toBe(-5)
  })
})

describe('planeLabelAt', () => {
  it('sits above the plane by the offset', () => {
    const xy = planePlacements(10).find((place) => place.id === 'XY')
    if (!xy) throw new Error('expected XY')
    expect(planeLabelAt(xy, 4)).toEqual([0, 0, 4])
  })
})

describe('visiblePlanes', () => {
  it('shows all three before anything is drawn', () => {
    expect(visiblePlanes(false, false)).toEqual([...DATUM_PLANES])
  })

  it('hides them once a solid exists', () => {
    expect(visiblePlanes(true, false)).toEqual([])
  })

  it('hides them while sketching', () => {
    expect(visiblePlanes(false, true)).toEqual([])
  })
})
