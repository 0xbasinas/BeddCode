import { describe, expect, it } from 'vitest'
import { cadWantWidth, openPaneWidth, rememberPaneWidth, urlAsksForCad } from './paneWidth.ts'

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

  it('asks for a wide CAD column, and a wider one when maximized', () => {
    expect(cadWantWidth(1440, false)).toBe(1100)
    expect(cadWantWidth(1800, false)).toBe(1260)
    expect(cadWantWidth(2400, false)).toBe(1400)
    expect(cadWantWidth(1000, false)).toBe(1100)
    expect(cadWantWidth(1920, true)).toBe(1616)
    expect(cadWantWidth(900, true)).toBe(1100)
    expect(cadWantWidth(0, false)).toBe(cadWantWidth(1440, false))
    expect(cadWantWidth(Number.NaN, true)).toBe(cadWantWidth(1440, true))
  })

  it('opens CAD from ?cad=1 or #cad', () => {
    expect(urlAsksForCad('?cad=1', '')).toBe(true)
    expect(urlAsksForCad('?x=2&cad=1', '')).toBe(true)
    expect(urlAsksForCad('?cad=0', '')).toBe(false)
    expect(urlAsksForCad('', '')).toBe(false)
    expect(urlAsksForCad('', '#cad')).toBe(true)
    expect(urlAsksForCad('', '#cad=1')).toBe(true)
    expect(urlAsksForCad('?other=1', '#cad')).toBe(true)
    expect(urlAsksForCad('', '#files')).toBe(false)
  })

  it('ignores the collapsed rail and works without storage', () => {
    const storage = memory()
    rememberPaneWidth(40, storage)
    expect(openPaneWidth(storage)).toBe('30%')
    expect(openPaneWidth(undefined)).toBe('30%')
    expect(() => rememberPaneWidth(500, undefined)).not.toThrow()
  })
})
