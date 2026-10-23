import { describe, expect, it } from 'vitest'
import { claudeLimits, readClaudeLimits } from './limits.ts'
import type { QueryFn } from './session.ts'

describe('claudeLimits', () => {
  it('turns the five-hour and weekly windows into rows with their reset times', () => {
    const result = claudeLimits({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 21, resets_at: '2026-10-23T11:39:59.530432+00:00' },
        seven_day: { utilization: 63, resets_at: '2026-10-23T14:59:59.530453+00:00' },
        seven_day_opus: null,
        model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: null }],
      },
    })
    expect(result.plan).toBe('pro')
    expect(result.windows).toEqual([
      {
        id: 'five-hour',
        label: '5-hour window',
        usedPercent: 21,
        resetsAt: Date.parse('2026-10-23T11:39:59.530432+00:00'),
      },
      {
        id: 'week',
        label: 'This week',
        usedPercent: 63,
        resetsAt: Date.parse('2026-10-23T14:59:59.530453+00:00'),
      },
      { id: 'week-model-0', label: 'Fable this week', usedPercent: 12, resetsAt: undefined },
    ])
  })

  it('says why there is nothing when the account has no plan limits', () => {
    expect(
      claudeLimits({ subscription_type: null, rate_limits_available: false, rate_limits: null }),
    ).toMatchObject({ windows: [], note: expect.stringContaining('subscription') })
  })

  it('keeps percentages in range and skips a window with no figure', () => {
    const result = claudeLimits({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 140, resets_at: null },
        seven_day: { utilization: null, resets_at: null },
      },
    })
    expect(result.windows).toEqual([
      { id: 'five-hour', label: '5-hour window', usedPercent: 100, resetsAt: undefined },
    ])
  })
})

describe('readClaudeLimits', () => {
  it('asks a query that was never sent a prompt, and always closes it', async () => {
    let closed = false
    let asked: unknown
    const queryFn = ((args: unknown) => {
      asked = args
      return {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          subscription_type: 'max',
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 5, resets_at: null } },
        }),
        close: () => (closed = true),
      }
    }) as unknown as QueryFn
    const result = await readClaudeLimits(queryFn, { cwd: '/w' })
    expect(result).toMatchObject({ plan: 'max', windows: [{ id: 'five-hour', usedPercent: 5 }] })
    expect(closed).toBe(true)
    expect((asked as { options: { cwd: string } }).options.cwd).toBe('/w')
  })

  it('gives up after the timeout and still closes it', async () => {
    let closed = false
    const queryFn = (() => ({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}),
      close: () => (closed = true),
    })) as unknown as QueryFn
    await expect(readClaudeLimits(queryFn, {}, 20)).rejects.toThrow('did not answer')
    expect(closed).toBe(true)
  })
})
