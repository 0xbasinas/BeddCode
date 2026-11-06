import { describe, expect, it } from 'vitest'
import {
  EMPTY_INPUT,
  canCommit,
  commitValue,
  formatNumber,
  parseNumericText,
  readoutText,
  typedText,
} from './inputState.ts'

describe('formatNumber', () => {
  it('trims trailing zeros', () => {
    expect(formatNumber(12)).toBe('12')
    expect(formatNumber(12.5)).toBe('12.5')
    expect(formatNumber(12.5004)).toBe('12.5')
  })

  it('rounds to three decimals', () => {
    expect(formatNumber(1.23456)).toBe('1.235')
  })

  it('falls back to 0 for non-finite input', () => {
    expect(formatNumber(Number.NaN)).toBe('0')
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('0')
  })
})

describe('parseNumericText', () => {
  it('accepts a plain number', () => {
    expect(parseNumericText('4')).toEqual({ value: 4 })
    expect(parseNumericText(' 4.5 ')).toEqual({ value: 4.5 })
    expect(parseNumericText('-2')).toEqual({ value: -2 })
  })

  it('rejects empty and garbage text', () => {
    expect(parseNumericText('')).toHaveProperty('error')
    expect(parseNumericText('   ')).toHaveProperty('error')
    expect(parseNumericText('abc')).toHaveProperty('error')
  })

  it('enforces min and max with readable messages', () => {
    expect(parseNumericText('-1', { min: 0 })).toEqual({ error: 'At least 0' })
    expect(parseNumericText('9', { max: 5 })).toEqual({ error: 'At most 5' })
    expect(parseNumericText('5', { min: 0, max: 5 })).toEqual({ value: 5 })
  })
})

describe('readoutText', () => {
  it('writes the value while the user has not typed', () => {
    const next = readoutText(EMPTY_INPUT, 7.5)
    expect(next.text).toBe('7.5')
    expect(next.written).toBe('7.5')
    expect(next.dirty).toBe(false)
  })

  it('refuses to overwrite once the user typed', () => {
    const typed = typedText(EMPTY_INPUT, '12')
    const afterDrag = readoutText(typed, 30)
    expect(afterDrag.text).toBe('12')
    expect(afterDrag.dirty).toBe(true)
  })

  it('keeps tracking when text still matches what it wrote', () => {
    const first = readoutText(EMPTY_INPUT, 4)
    const second = readoutText(first, 9)
    expect(second.text).toBe('9')
    expect(second.dirty).toBe(false)
  })
})

describe('typedText', () => {
  it('clears the error when the text parses', () => {
    const bad = typedText(EMPTY_INPUT, 'abc')
    expect(bad.error).toBe('Not a number')
    const good = typedText(bad, '3')
    expect(good.error).toBeNull()
    expect(good.dirty).toBe(true)
  })

  it('treats text equal to the written value as not dirty', () => {
    const ready = readoutText(EMPTY_INPUT, 4)
    const same = typedText(ready, '4')
    expect(same.dirty).toBe(false)
    expect(same.error).toBeNull()
  })

  it('applies limits to the error tip', () => {
    const state = typedText(EMPTY_INPUT, '-3', { min: 0 })
    expect(state.error).toBe('At least 0')
  })
})

describe('canCommit and commitValue', () => {
  it('will not commit an untouched readout', () => {
    const ready = readoutText(EMPTY_INPUT, 4)
    expect(canCommit(ready)).toBe(false)
    expect(commitValue(ready)).toBe(4)
  })

  it('commits a valid typed value', () => {
    const typed = typedText(EMPTY_INPUT, '6.5')
    expect(canCommit(typed)).toBe(true)
    expect(commitValue(typed)).toBe(6.5)
  })

  it('will not commit text that fails validation', () => {
    const typed = typedText(EMPTY_INPUT, '-1', { min: 0 })
    expect(canCommit(typed, { min: 0 })).toBe(false)
    expect(commitValue(typed, { min: 0 })).toBeNull()
  })
})
