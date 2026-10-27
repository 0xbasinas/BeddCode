import { describe, expect, it } from 'vitest'
import { readingPosition, rememberReadingPosition, threadKey } from './threadState.ts'

describe('chat reading position', () => {
  it('remembers earlier messages along with the scroll position independently per chat', () => {
    const a = threadKey('local', 'reading-a')
    const b = threadKey('local', 'reading-b')
    rememberReadingPosition(a, { from: 12 })
    rememberReadingPosition(a, { top: 850, following: false })
    rememberReadingPosition(b, { top: 2000, following: true })
    expect(readingPosition(a)).toEqual({ from: 12, top: 850, following: false })
    expect(readingPosition(b)).toEqual({ top: 2000, following: true })
    rememberReadingPosition(a, { following: true })
    expect(readingPosition(a)?.from).toBe(12)
    expect(readingPosition(a)?.following).toBe(true)
  })
})
