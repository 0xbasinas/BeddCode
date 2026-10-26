import { describe, expect, it } from 'vitest'
import { dailySeries, percentile, summarize, validateBatch } from './metrics.ts'

const ok = {
  host: 'abc123',
  platform: 'mobile',
  records: [{ t: 1, name: 'replay.ms', value: 420 }],
}

describe('validateBatch', () => {
  it('accepts a well-formed batch, with or without labels', () => {
    expect(validateBatch(ok)).toEqual(ok)
    const tagged = { ...ok, records: [{ ...ok.records[0], tags: { route: 'relay' } }] }
    expect(validateBatch(tagged)?.records[0]?.tags).toEqual({ route: 'relay' })
  })

  it('refuses anything that could carry content', () => {
    const bad = (records: unknown) => validateBatch({ ...ok, records })
    expect(bad([{ t: 1, name: 'Has Spaces', value: 1 }])).toBeNull()
    expect(bad([{ t: 1, name: 'x', value: '1' }])).toBeNull()
    expect(bad([{ t: 1, name: 'x', value: Number.NaN }])).toBeNull()
    expect(
      bad([{ t: 1, name: 'x', value: 1, tags: { path: '/home/me/secret project' } }]),
    ).toBeNull()
    expect(bad([{ t: 1, name: 'x', value: 1, tags: { route: 'x'.repeat(41) } }])).toBeNull()
    expect(bad(new Array(501).fill(ok.records[0]))).toBeNull()
    expect(validateBatch({ ...ok, host: 'Not Allowed' })).toBeNull()
    expect(validateBatch({ ...ok, platform: 'toaster' })).toBeNull()
    expect(validateBatch('nope')).toBeNull()
  })
})

describe('summarize', () => {
  it('splits cold from warm starts and groups by day', () => {
    const day = Date.UTC(2026, 9, 25, 12)
    const base = { name: 'replay.ms', platform: 'mobile', route: 'relay' }
    const rows = [
      { ...base, t: day, resume: 'cold', value: 3000 },
      { ...base, t: day, resume: 'warm', value: 200 },
      { ...base, t: day + 86_400_000, resume: 'warm', value: 300 },
    ]
    expect(
      summarize(rows)
        .map((r) => r.resume)
        .sort(),
    ).toEqual(['cold', 'warm'])
    const daily = dailySeries(rows)
    expect(daily.map((d) => d.day)).toEqual(['2026-10-25', '2026-10-25', '2026-10-26'])
    expect(daily.find((d) => d.resume === 'cold')).toMatchObject({ count: 1, p50: 3000 })
  })

  it('computes percentiles per name, platform and route', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10)
    const rows = [100, 200, 300, 400].map((value) => ({
      name: 'replay.ms',
      platform: 'mobile',
      route: 'relay',
      value,
    }))
    rows.push({ name: 'replay.ms', platform: 'mobile', route: null as never, value: 5 })
    const out = summarize(rows)
    expect(out).toHaveLength(2)
    const relay = out.find((r) => r.route === 'relay')!
    expect(relay).toMatchObject({ count: 4, p50: 200, p95: 400, max: 400, avg: 250 })
  })
})
