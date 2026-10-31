import { describe, expect, it } from 'vitest'
import { NO_FILTERS, activeFilterCount, matchesFilters, toggled } from './sessionFilters.ts'

const now = new Date(2026, 5, 15, 12).getTime()
const hour = 60 * 60 * 1000
const s = (over: Partial<Parameters<typeof matchesFilters>[0]> = {}) => ({
  status: 'idle' as const,
  updatedAt: now,
  ...over,
})

describe('matchesFilters', () => {
  it('lets everything through when nothing is chosen', () => {
    expect(matchesFilters(s(), 'h\n/a', NO_FILTERS, now)).toBe(true)
  })

  it('matches any of the chosen statuses and projects', () => {
    const f = { ...NO_FILTERS, statuses: ['running' as const, 'failed' as const] }
    expect(matchesFilters(s({ status: 'failed' }), 'k', f, now)).toBe(true)
    expect(matchesFilters(s({ status: 'idle' }), 'k', f, now)).toBe(false)
    const p = { ...NO_FILTERS, projects: ['h\n/a'] }
    expect(matchesFilters(s(), 'h\n/a', p, now)).toBe(true)
    expect(matchesFilters(s(), 'h\n/b', p, now)).toBe(false)
  })

  it('requires every kind of filter to hold', () => {
    const f = { ...NO_FILTERS, pinnedOnly: true, worktreeOnly: true }
    expect(matchesFilters(s({ pinned: true }), 'k', f, now)).toBe(false)
    expect(matchesFilters(s({ pinned: true, worktree: { baseBranch: 'main' } }), 'k', f, now)).toBe(
      true,
    )
  })

  it('limits by activity window', () => {
    const today = { ...NO_FILTERS, since: 'today' as const }
    expect(matchesFilters(s({ updatedAt: now - hour }), 'k', today, now)).toBe(true)
    expect(matchesFilters(s({ updatedAt: now - 13 * hour }), 'k', today, now)).toBe(false)
    const week = { ...NO_FILTERS, since: 'week' as const }
    expect(matchesFilters(s({ updatedAt: now - 6 * 24 * hour }), 'k', week, now)).toBe(true)
    expect(matchesFilters(s({ updatedAt: now - 8 * 24 * hour }), 'k', week, now)).toBe(false)
  })
})

describe('activeFilterCount', () => {
  it('counts each chosen value', () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0)
    expect(
      activeFilterCount({
        statuses: ['idle', 'running'],
        projects: ['x'],
        since: 'week',
        pinnedOnly: true,
        worktreeOnly: false,
      }),
    ).toBe(5)
  })
})

describe('toggled', () => {
  it('adds and removes', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggled(['a', 'b'], 'a')).toEqual(['b'])
  })
})
