import { describe, expect, it } from 'vitest'
import { nextCullBounds } from './cull-bounds'

const view = (x: number, y: number, w = 1000, h = 600) => ({
  minX: x,
  minY: y,
  maxX: x + w,
  maxY: y + h,
})

describe('nextCullBounds', () => {
  it('pads the viewport, and keeps the same object while panning inside the padding', () => {
    const first = nextCullBounds(view(0, 0), view(5000, 5000))
    expect(first).toEqual({ minX: -250, maxX: 1250, minY: -150, maxY: 750 })
    expect(nextCullBounds(view(100, 50), first)).toBe(first)
    expect(nextCullBounds(view(-150, -90), first)).toBe(first)
  })

  it('moves the area once the viewport nears its edge', () => {
    const first = nextCullBounds(view(0, 0), view(5000, 5000))
    const moved = nextCullBounds(view(230, 0), first)
    expect(moved).not.toBe(first)
    expect(moved.minX).toBe(-20)
  })

  it('is replaced when the zoom changes the viewport size a lot', () => {
    const first = nextCullBounds(view(0, 0), view(5000, 5000))
    expect(nextCullBounds(view(0, 0, 400, 240), first)).not.toBe(first)
    expect(nextCullBounds(view(0, 0, 2500, 1500), first)).not.toBe(first)
    // a small zoom step keeps it
    expect(nextCullBounds(view(0, 0, 1100, 660), first)).toBe(first)
  })
})
