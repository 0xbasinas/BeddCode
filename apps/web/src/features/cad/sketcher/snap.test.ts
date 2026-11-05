import { describe, expect, it } from 'vitest'
import type { SketchEntity } from './types.ts'
import { gridStepForShift, resolveSnap } from './snap.ts'

const line: SketchEntity = { id: 'l', kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }

describe('snap priority', () => {
  it('prefers an endpoint over a closer midpoint', () => {
    const short: SketchEntity = { id: 's', kind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }
    const choice = resolveSnap({
      cursor: [0.35, 0],
      tolerance: 0.5,
      gridStep: 1,
      entities: [short],
    })
    expect(choice).toEqual({ point: [0, 0], kind: 'endpoint' })
  })

  it('uses a midpoint when no endpoint is in range', () => {
    const choice = resolveSnap({
      cursor: [5.2, 0.3],
      tolerance: 1,
      gridStep: 1,
      entities: [line],
    })
    expect(choice).toEqual({ point: [5, 0], kind: 'midpoint' })
  })

  it('locks horizontal and vertical from the last point ahead of the grid', () => {
    const horizontal = resolveSnap({
      cursor: [8.2, 0.4],
      tolerance: 0.5,
      gridStep: 1,
      anchor: [0, 0],
      entities: [line],
    })
    expect(horizontal).toEqual({ point: [8.2, 0], kind: 'axis' })

    const vertical = resolveSnap({
      cursor: [0.2, 6.4],
      tolerance: 0.5,
      gridStep: 1,
      anchor: [0, 0],
    })
    expect(vertical).toEqual({ point: [0, 6.4], kind: 'axis' })
  })

  it('falls through to the grid, including the coarse step', () => {
    expect(
      resolveSnap({
        cursor: [3.2, 4.4],
        tolerance: 0.5,
        gridStep: 1,
        anchor: [0, 0],
        entities: [line],
      }),
    ).toEqual({ point: [3, 4], kind: 'grid' })

    expect(
      resolveSnap({
        cursor: [7.2, 7.4],
        tolerance: 0.4,
        gridStep: 5,
        anchor: [0, 0],
      }),
    ).toEqual({ point: [5, 5], kind: 'grid' })
  })

  it('keeps an endpoint ahead of a coarse grid and treats the anchor as an endpoint', () => {
    expect(
      resolveSnap({
        cursor: [0.4, 0.2],
        tolerance: 1,
        gridStep: 5,
        entities: [line],
      }).kind,
    ).toBe('endpoint')

    expect(
      resolveSnap({
        cursor: [4.1, 0.2],
        tolerance: 0.5,
        gridStep: 1,
        anchor: [4, 0],
      }),
    ).toEqual({ point: [4, 0], kind: 'endpoint' })
  })

  it('swaps the 1 mm and 5 mm steps while shift is held', () => {
    expect(gridStepForShift(1, false)).toBe(1)
    expect(gridStepForShift(1, true)).toBe(5)
    expect(gridStepForShift(5, true)).toBe(1)
    expect(gridStepForShift(5, false)).toBe(5)
  })
})
