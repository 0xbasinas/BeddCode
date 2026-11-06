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

describe('center snap', () => {
  const circle: SketchEntity = { id: 'c', kind: 'circle', cx: 4, cy: 4, radius: 3 }

  it('snaps to a circle center', () => {
    const choice = resolveSnap({
      cursor: [4.2, 4.1],
      tolerance: 0.6,
      gridStep: 1,
      entities: [circle],
    })
    expect(choice).toEqual({ point: [4, 4], kind: 'center' })
  })

  it('snaps to a rectangle center', () => {
    const rect: SketchEntity = { id: 'r', kind: 'rect', x: 0, y: 0, width: 10, height: 6 }
    const choice = resolveSnap({
      cursor: [5.1, 3.1],
      tolerance: 0.5,
      gridStep: 1,
      entities: [rect],
    })
    expect(choice).toEqual({ point: [5, 3], kind: 'center' })
  })

  it('waits behind an endpoint in range', () => {
    // A line endpoint sits under the cursor and the circle center is also near,
    // so the endpoint priority has to win.
    const near: SketchEntity = { id: 'l', kind: 'line', x1: 4, y1: 8, x2: 9, y2: 9 }
    const choice = resolveSnap({
      cursor: [4.1, 4.2],
      tolerance: 0.5,
      gridStep: 1,
      entities: [circle, near],
    })
    expect(choice.kind).toBe('center')

    const lineNearCenter: SketchEntity = { id: 'm', kind: 'line', x1: 4, y1: 4, x2: 9, y2: 4 }
    const won = resolveSnap({
      cursor: [4.1, 4.1],
      tolerance: 0.5,
      gridStep: 1,
      entities: [circle, lineNearCenter],
    })
    expect(won.kind).toBe('endpoint')
  })
})

describe('snap settings', () => {
  const circle: SketchEntity = { id: 'c', kind: 'circle', cx: 4, cy: 4, radius: 3 }

  it('drops the grid only when the master switch is off', () => {
    const choice = resolveSnap({
      cursor: [4.1, 4.1],
      tolerance: 1,
      gridStep: 1,
      entities: [circle],
      enabled: false,
    })
    expect(choice.kind).toBe('grid')
  })

  it('skips a kind that is switched off', () => {
    const choice = resolveSnap({
      cursor: [4.1, 4.1],
      tolerance: 1,
      gridStep: 1,
      entities: [circle],
      settings: { center: false },
    })
    expect(choice.kind).toBe('grid')
  })

  it('still finds endpoints when only the midpoint is off', () => {
    const choice = resolveSnap({
      cursor: [5.1, 0],
      tolerance: 0.6,
      gridStep: 1,
      entities: [line],
      settings: { midpoint: false },
    })
    expect(choice.kind).not.toBe('midpoint')
  })

  it('keeps the anchor as an endpoint when endpoints are on', () => {
    const choice = resolveSnap({
      cursor: [0.2, 0.1],
      tolerance: 0.5,
      gridStep: 1,
      anchor: [0, 0],
      entities: [],
    })
    expect(choice).toEqual({ point: [0, 0], kind: 'endpoint' })
  })

  it('leaves the anchor to the axis lock when endpoints are off', () => {
    const choice = resolveSnap({
      cursor: [0.2, 2],
      tolerance: 0.5,
      gridStep: 1,
      anchor: [0, 0],
      entities: [],
      settings: { endpoint: false },
    })
    expect(choice).toEqual({ point: [0, 2], kind: 'axis' })
  })
})
