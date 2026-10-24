import { describe, expect, it } from 'vitest'
import { retryWhileCurrent } from './retry.ts'

describe('retryWhileCurrent', () => {
  it('keeps trying with growing waits until it works, reporting each failure', async () => {
    const waits: number[] = []
    const errors: string[] = []
    let calls = 0
    const result = await retryWhileCurrent(
      async () => {
        calls++
        if (calls < 4) throw new Error(`fail ${calls}`)
        return 'ok'
      },
      {
        delaysMs: [10, 20],
        sleep: async (ms) => void waits.push(ms),
        onError: (e) => errors.push(e.message),
      },
    )
    expect(result).toBe('ok')
    expect(waits).toEqual([10, 20, 20])
    expect(errors).toEqual(['fail 1', 'fail 2', 'fail 3'])
  })

  it('stops when the result no longer matters, without reporting that failure', async () => {
    let current = true
    const errors: string[] = []
    const result = await retryWhileCurrent(
      async () => {
        current = false
        throw new Error('connection lost')
      },
      { sleep: async () => {}, isCurrent: () => current, onError: (e) => errors.push(e.message) },
    )
    expect(result).toBeUndefined()
    expect(errors).toEqual([])
  })
})
