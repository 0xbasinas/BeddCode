import { describe, expect, it } from 'vitest'
import { DEFAULT_OFFSET, clampOffset, loadOffset, saveOffset } from './floating.ts'

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
