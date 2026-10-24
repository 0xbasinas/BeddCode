import { describe, expect, it } from 'vitest'
import type { Schedule, ScheduleRun } from '@beddcode/contracts'
import { findSchedule, formatRuns, formatSchedules, parseTrigger } from './manageCmds.ts'

const schedule = (over: Partial<Schedule> & { id: string; name: string }): Schedule => ({
  prompt: 'p',
  trigger: { kind: 'every', minutes: 30 },
  target: { kind: 'session', sessionId: 's' },
  paused: false,
  createdAt: 0,
  ...over,
})

describe('parseTrigger', () => {
  it('reads intervals in minutes, hours and days', () => {
    expect(parseTrigger('every 30m')).toEqual({ kind: 'every', minutes: 30 })
    expect(parseTrigger('every 2 hours')).toEqual({ kind: 'every', minutes: 120 })
    expect(parseTrigger('Every 1d')).toEqual({ kind: 'every', minutes: 1440 })
  })

  it('keeps a five-field cron as it is, with single spaces', () => {
    expect(parseTrigger('0  9 * * 1-5')).toEqual({ kind: 'cron', expr: '0 9 * * 1-5' })
  })

  it('refuses anything else, and intervals out of range', () => {
    expect(() => parseTrigger('daily')).toThrow('neither')
    expect(() => parseTrigger('0 9 * *')).toThrow('five-field')
    expect(() => parseTrigger('every 0m')).toThrow('1 minute to 7 days')
    expect(() => parseTrigger('every 8d')).toThrow('1 minute to 7 days')
  })
})

describe('schedules', () => {
  const now = 1_000_000_000
  const list = [
    schedule({ id: 'aaaa1111', name: 'Build check', nextRunAt: now + 30 * 60_000 }),
    schedule({
      id: 'bbbb2222',
      name: 'Triage issues',
      trigger: { kind: 'cron', expr: '0 9 * * 1-5' },
      paused: true,
      lastRunAt: now - 3_600_000,
    }),
  ]

  it('lists them with state, timing and a readable interval', () => {
    const text = formatSchedules(list, now)
    expect(text).toContain('active  every 30m')
    expect(text).toContain('in 30m')
    expect(text).toMatch(/paused\s+0 9 \* \* 1-5\s+-\s+1h ago\s+Triage issues/)
    expect(formatSchedules([])).toContain('No schedules')
  })

  it('finds one by id start, name, or part of a name', () => {
    expect(findSchedule(list, 'aaaa').id).toBe('aaaa1111')
    expect(findSchedule(list, 'triage issues').id).toBe('bbbb2222')
    expect(findSchedule(list, 'build').id).toBe('aaaa1111')
    expect(() => findSchedule(list, 'nope')).toThrow('No schedule matches')
    expect(() => findSchedule(list, 'i')).toThrow('matches 2')
    expect(() => findSchedule(list, undefined)).toThrow('Which schedule')
  })

  it('lists runs newest first with the schedule name', () => {
    const runs: ScheduleRun[] = [
      { id: 'r1r1r1r1', scheduleId: 'aaaa1111', startedAt: now - 7_200_000, status: 'done' },
      {
        id: 'r2r2r2r2',
        scheduleId: 'aaaa1111',
        startedAt: now - 60_000,
        status: 'skipped',
        note: 'still running',
      },
    ]
    const lines = formatRuns(runs, list, now).split('\n')
    expect(lines[0]).toContain('skipped')
    expect(lines[0]).toContain('still running')
    expect(lines[1]).toContain('Build check')
    expect(formatRuns([], list)).toBe('No runs yet.')
  })
})
