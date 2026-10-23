import { describe, expect, it } from 'vitest'
import {
  formatCost,
  formatReset,
  formatTokens,
  percentOfTotal,
  planName,
  shares,
  tokensOf,
} from './usageFormat.ts'

describe('formatTokens', () => {
  it('writes small, thousands and millions plainly', () => {
    expect(formatTokens(950)).toBe('950 tokens')
    expect(formatTokens(184_300)).toBe('184k tokens')
    expect(formatTokens(61_000)).toBe('61k tokens')
    expect(formatTokens(1_250_000)).toBe('1.3M tokens')
  })
})

describe('formatCost', () => {
  it('writes dollars and cents, and nothing when there was no cost', () => {
    expect(formatCost(0.0184)).toBe('$0.02')
    expect(formatCost(1.4)).toBe('$1.40')
    expect(formatCost(0.002)).toBe('<$0.01')
    expect(formatCost(0)).toBeUndefined()
  })
})

describe('formatReset', () => {
  const now = new Date(2026, 9, 22, 12, 0).getTime()
  it('counts down within a day, and names the day after that', () => {
    expect(formatReset(now + 2 * 3_600_000 + 10 * 60_000, now)).toBe('Resets in 2h 10m')
    expect(formatReset(now + 45 * 60_000, now)).toBe('Resets in 45m')
    expect(formatReset(now + 3 * 24 * 3_600_000, now)).toMatch(/^Resets \w+/)
  })
  it('says so when it is already over, and nothing when unknown', () => {
    expect(formatReset(now - 1000, now)).toBe('Resetting now')
    expect(formatReset(undefined, now)).toBeUndefined()
  })
})

describe('shares', () => {
  it('scales rows against the largest, and copes with all zero', () => {
    expect(shares([{ n: 50 }, { n: 100 }, { n: 0 }], (r) => r.n)).toEqual([50, 100, 0])
    expect(shares([{ n: 0 }], (r) => r.n)).toEqual([0])
    expect(shares([], (r: { n: number }) => r.n)).toEqual([])
  })
  it('gives each row its percent of the total', () => {
    expect(percentOfTotal([{ n: 71 }, { n: 22 }, { n: 7 }], (r) => r.n)).toEqual([71, 22, 7])
    expect(percentOfTotal([{ n: 0 }], (r) => r.n)).toEqual([0])
  })
})

describe('tokensOf and planName', () => {
  it('adds everything read and written', () => {
    expect(
      tokensOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
    ).toBe(10)
  })
  it('spells plans for reading', () => {
    expect(planName('pro')).toBe('Pro')
    expect(planName('promax')).toBe('Pro Max')
    expect(planName('self_serve')).toBe('Self_serve')
    expect(planName(undefined)).toBeUndefined()
  })
})
