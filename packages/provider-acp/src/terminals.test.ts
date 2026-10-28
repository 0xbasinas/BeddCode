import { describe, expect, it } from 'vitest'
import { tailWithin } from './terminals.ts'

describe('tailWithin', () => {
  it('keeps text that fits', () => {
    expect(tailWithin('hello', 10)).toBe('hello')
  })

  it('keeps the end, cut at a character boundary', () => {
    // "é" is two bytes; a 3-byte limit over "aéé" must not split the first one.
    expect(tailWithin('aéé', 3)).toBe('é')
    expect(tailWithin('abcdef', 3)).toBe('def')
  })
})
