import { describe, expect, it } from 'vitest'
import { openPaneWidth, rememberPaneWidth } from './paneWidth.ts'

const memory = () => {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

describe('right pane width', () => {
  it('opens at 30% until a pane has been open, then at its last width', () => {
    const storage = memory()
    expect(openPaneWidth(storage)).toBe('30%')
    rememberPaneWidth(529.6, storage)
    expect(openPaneWidth(storage)).toBe(530)
  })

  it('ignores the collapsed rail and works without storage', () => {
    const storage = memory()
    rememberPaneWidth(40, storage)
    expect(openPaneWidth(storage)).toBe('30%')
    expect(openPaneWidth(undefined)).toBe('30%')
    expect(() => rememberPaneWidth(500, undefined)).not.toThrow()
  })
})
