import { describe, expect, it } from 'vitest'
import { controlsInsets } from './windowControls.ts'

describe('controlsInsets', () => {
  it('finds controls on the right (Windows, Linux)', () => {
    expect(controlsInsets({ x: 0, width: 1304, height: 44 }, 1400)).toEqual({
      left: 0,
      right: 96,
      height: 44,
    })
  })

  it('finds controls on the left (macOS) and never goes negative', () => {
    expect(controlsInsets({ x: 78, width: 1322, height: 28 }, 1400)).toEqual({
      left: 78,
      right: 0,
      height: 28,
    })
    expect(controlsInsets({ x: -1, width: 1500, height: 0 }, 1400)).toEqual({
      left: 0,
      right: 0,
      height: 0,
    })
  })
})
