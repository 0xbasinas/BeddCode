import { describe, expect, it } from 'vitest'
import { baseName, languageName } from './fileIcons.ts'

describe('file icons', () => {
  it('names languages for the status bar', () => {
    expect(languageName('a.tsx')).toBe('TypeScript')
    expect(languageName('README.md')).toBe('Markdown')
    expect(languageName('LICENSE')).toBe('Plain text')
  })

  it('takes the last path segment', () => {
    expect(baseName('src/limiter/index.ts')).toBe('index.ts')
    expect(baseName('a.ts')).toBe('a.ts')
  })
})
