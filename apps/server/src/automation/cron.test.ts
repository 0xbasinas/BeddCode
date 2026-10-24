import { describe, expect, it } from 'vitest'
import { nextCron, nextRun, parseCron, previewTrigger } from './cron.ts'

const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime()

describe('cron', () => {
  it('parses steps, ranges, lists and names', () => {
    const c = parseCron('*/15 9-17 * jan,jun mon-fri')
    expect([...c.minutes]).toEqual([0, 15, 30, 45])
    expect(c.hours.size).toBe(9)
    expect([...c.months]).toEqual([1, 6])
    expect([...c.weekdays]).toEqual([1, 2, 3, 4, 5])
    expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0])
    expect(() => parseCron('* * *')).toThrow(/five fields/)
    expect(() => parseCron('61 * * * *')).toThrow(/out of range/)
  })

  it('finds the next matching minute', () => {
    // 2026-10-23 is a Friday.
    const friday = at(2026, 10, 23, 10, 7)
    expect(nextCron(parseCron('*/15 * * * *'), friday)).toBe(at(2026, 10, 23, 10, 15))
    expect(nextCron(parseCron('0 9 * * mon'), friday)).toBe(at(2026, 10, 26, 9, 0))
    expect(nextCron(parseCron('@daily'), friday)).toBe(at(2026, 10, 24, 0, 0))
    expect(nextCron(parseCron('30 8 1 * *'), friday)).toBe(at(2026, 11, 1, 8, 30))
    // Day of month or day of week, when both are given.
    expect(nextCron(parseCron('0 0 1 * fri'), friday)).toBe(at(2026, 10, 30, 0, 0))
    expect(nextCron(parseCron('0 0 30 2 *'), friday)).toBeUndefined()
  })

  it('counts intervals from the last run without making up missed ones', () => {
    const t0 = at(2026, 10, 23, 10, 0)
    const every5 = { kind: 'every' as const, minutes: 5 }
    expect(nextRun(every5, t0 + 60_000, t0)).toBe(t0 + 5 * 60_000)
    // Off for an hour: fires once, on the grid, not twelve times.
    expect(nextRun(every5, t0 + 61 * 60_000, t0)).toBe(t0 + 65 * 60_000)
  })

  it('previews the next times or explains the mistake', () => {
    const t0 = at(2026, 10, 23, 10, 0)
    expect(previewTrigger({ kind: 'every', minutes: 30 }, t0).times).toEqual([
      t0 + 30 * 60_000,
      t0 + 60 * 60_000,
      t0 + 90 * 60_000,
    ])
    expect(previewTrigger({ kind: 'cron', expr: 'x * * * *' }, t0).error).toMatch(/range/)
  })
})
