import { describe, expect, it } from 'vitest'
import { codexLimits, readCodexLimits } from './limits.ts'
import type { WithAppServer } from './history.ts'

describe('codexLimits', () => {
  it('names the windows by their length and converts the reset times', () => {
    const result = codexLimits({
      rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_792_757_203 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_793_344_003 },
      },
    })
    expect(result).toEqual({
      plan: 'plus',
      windows: [
        { id: 'primary', label: '5-hour window', usedPercent: 40, resetsAt: 1_792_757_203_000 },
        { id: 'secondary', label: 'This week', usedPercent: 12, resetsAt: 1_793_344_003_000 },
      ],
    })
  })

  it('names unusual windows plainly and copes with missing parts', () => {
    expect(
      codexLimits({
        rateLimits: { primary: { usedPercent: 3, windowDurationMins: 1440 }, secondary: null },
      }).windows,
    ).toEqual([{ id: 'primary', label: '1-day window', usedPercent: 3, resetsAt: undefined }])
    expect(codexLimits({})).toMatchObject({ windows: [], note: expect.any(String) })
  })
})

describe('readCodexLimits', () => {
  it('reads them through an app server', async () => {
    const withAppServer = (async (fn) =>
      fn({
        request: async (method: string) => {
          expect(method).toBe('account/rateLimits/read')
          return {
            rateLimits: { planType: 'pro', primary: { usedPercent: 1, windowDurationMins: 300 } },
          }
        },
      } as never)) as WithAppServer
    expect(await readCodexLimits(withAppServer)).toMatchObject({
      plan: 'pro',
      windows: [{ usedPercent: 1 }],
    })
  })
})
