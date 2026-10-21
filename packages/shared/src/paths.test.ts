import { describe, expect, it } from 'vitest'
import { displayPath } from './paths.ts'

describe('displayPath', () => {
  it('shows files inside the folder relative to it, with forward slashes', () => {
    expect(displayPath('/work/src/a.ts', '/work')).toBe('src/a.ts')
    expect(displayPath('/work/a.ts', '/work')).toBe('a.ts')
  })

  it('leaves outside paths and missing folders unchanged', () => {
    expect(displayPath('/elsewhere/x.ts', '/work')).toBe('/elsewhere/x.ts')
    expect(displayPath('/work/a.ts', undefined)).toBe('/work/a.ts')
    expect(displayPath('/work', '/work')).toBe('/work')
  })
})
