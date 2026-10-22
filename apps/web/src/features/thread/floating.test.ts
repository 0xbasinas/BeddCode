import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OFFSET,
  MIN_COLUMN,
  cardReserve,
  clampOffset,
  loadOffset,
  saveOffset,
  shouldDock,
  snapOffset,
} from './floating.ts'

const container = { width: 800, height: 600 }
const card = { width: 300, height: 400 }

describe('clampOffset', () => {
  it('leaves a position that fits alone', () => {
    expect(clampOffset({ right: 100, top: 50 }, container, card)).toEqual({ right: 100, top: 50 })
  })

  it('keeps the card inside on every side', () => {
    expect(clampOffset({ right: -40, top: -10 }, container, card)).toEqual({ right: 8, top: 8 })
    expect(clampOffset({ right: 900, top: 900 }, container, card)).toEqual({ right: 492, top: 192 })
  })

  it('pins a card bigger than its container to the corner', () => {
    expect(clampOffset({ right: 200, top: 200 }, { width: 200, height: 200 }, card)).toEqual({
      right: 8,
      top: 8,
    })
  })
})

describe('saved position', () => {
  const memory = () => {
    const data = new Map<string, string>()
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
  }

  it('round-trips, and falls back to the default for anything unusable', () => {
    const storage = memory()
    expect(loadOffset(storage)).toEqual(DEFAULT_OFFSET)
    saveOffset(storage, { right: 30, top: 120 })
    expect(loadOffset(storage)).toEqual({ right: 30, top: 120 })

    storage.setItem('beddcode.environment-card', '{"right":"x"}')
    expect(loadOffset(storage)).toEqual(DEFAULT_OFFSET)
    storage.setItem('beddcode.environment-card', 'nope')
    expect(loadOffset(storage)).toEqual(DEFAULT_OFFSET)
    expect(loadOffset(undefined)).toEqual(DEFAULT_OFFSET)
  })

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    expect(loadOffset(broken)).toEqual(DEFAULT_OFFSET)
    expect(() => saveOffset(broken, DEFAULT_OFFSET)).not.toThrow()
  })
})

describe('cardReserve', () => {
  const column = { padding: 32, maxWidth: 740 }
  const right = { right: 16, top: 76 }
  const env = { width: 300, height: 500 }
  /** Where the column's text starts and ends with the reserve applied. */
  const edges = (width: number, r: { left: number; right: number }) => {
    const inner = Math.min(column.maxWidth, width - 2 * column.padding - r.left - r.right)
    const start = (width + r.left - r.right - inner) / 2
    return { start, end: start + inner, inner }
  }

  it('needs no room when the centered conversation already clears the card', () => {
    expect(cardReserve(1800, right, env, column)).toEqual({ left: 0, right: 0 })
  })

  it('moves the conversation out from under a card on the right', () => {
    for (const width of [900, 1100, 1300]) {
      const reserve = cardReserve(width, right, env, column)
      expect(reserve.right).toBeGreaterThan(0)
      expect(edges(width, reserve).end).toBeLessThanOrEqual(width - 16 - 300 - 12 + 0.5)
    }
  })

  it('shifts a full-width column rather than narrowing it when there is room', () => {
    expect(edges(1300, cardReserve(1300, right, env, column)).inner).toBe(740)
  })

  it('makes room on the left for a card dragged to the left side', () => {
    const at = { right: 780, top: 76 }
    const reserve = cardReserve(1100, at, env, column)
    expect(reserve.right).toBe(0)
    expect(edges(1100, reserve).start).toBeGreaterThanOrEqual(1100 - 780 + 12 - 0.5)
  })

  it('never squeezes the conversation below a readable width', () => {
    const reserve = cardReserve(600, right, env, column)
    expect(600 - 64 - reserve.left - reserve.right).toBeGreaterThanOrEqual(360)
  })
})

describe('snapOffset', () => {
  const thread = { width: 900, height: 700 }
  const env = { width: 300, height: 340 }

  it('snaps a card dropped mid-thread to the nearer side edge, keeping its height', () => {
    // Middle at x=420, left of centre: hugs the left edge.
    expect(snapOffset({ right: 330, top: 200 }, thread, env)).toEqual({
      right: 900 - 300 - 16,
      top: 200,
      side: 'left',
    })
    // Middle at x=520: back to the right edge.
    expect(snapOffset({ right: 230, top: 120 }, thread, env)).toEqual({
      right: 16,
      top: 120,
      side: 'right',
    })
  })

  it('keeps a left-snapped card on the left edge when the thread is resized', () => {
    const left = snapOffset({ right: 500, top: 76 }, thread, env)
    expect(clampOffset(left, { width: 1400, height: 700 }, env)).toEqual({
      right: 1400 - 300 - 16,
      top: 76,
      side: 'left',
    })
  })

  it('remembers the side across reloads', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
    saveOffset(storage, { right: 584, top: 90, side: 'left' })
    expect(loadOffset(storage)).toEqual({ right: 584, top: 90, side: 'left' })
    storage.setItem('beddcode.environment-card', '{"right":10,"top":10,"side":"up"}')
    expect(loadOffset(storage)).toEqual({ right: 10, top: 10 })
  })

  it('leaves the conversation a clear side once snapped, at any floating width', () => {
    const column = { padding: 32, maxWidth: 740 }
    for (const width of [760, 900, 1100, 1300]) {
      if (shouldDock(width, column)) continue
      for (const dropAt of [40, width / 2 - 100, width / 2 + 10, width - 400]) {
        const snapped = snapOffset({ right: dropAt, top: 76 }, { width, height: 700 }, env)
        const r = cardReserve(width, snapped, env, column)
        const inner = Math.min(column.maxWidth, width - 2 * column.padding - r.left - r.right)
        const start = (width + r.left - r.right - inner) / 2
        const cardLeft = width - snapped.right - env.width
        const cardRight = width - snapped.right
        // The column sits wholly on one side of the card, and stays readable.
        expect(start + inner <= cardLeft + 0.5 || start >= cardRight - 0.5).toBe(true)
        expect(inner).toBeGreaterThanOrEqual(MIN_COLUMN)
      }
    }
  })
})

describe('shouldDock', () => {
  const column = { padding: 32, maxWidth: 740 }

  it('floats the card when a readable column still fits beside it', () => {
    expect(shouldDock(900, column)).toBe(false)
    expect(shouldDock(1200, column)).toBe(false)
  })

  it('docks it above the conversation when the column would drop under MIN_COLUMN', () => {
    // The ~930px window from the bug report leaves the thread about 600px wide.
    expect(shouldDock(610, column)).toBe(true)
    expect(shouldDock(500, column)).toBe(true)
    // The boundary: padding, card, edge, gap and MIN_COLUMN exactly.
    expect(shouldDock(64 + 300 + 16 + 12 + MIN_COLUMN, column)).toBe(false)
    expect(shouldDock(64 + 300 + 16 + 12 + MIN_COLUMN - 1, column)).toBe(true)
  })
})
