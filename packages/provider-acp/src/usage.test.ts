import { describe, expect, it } from 'vitest'
import { promptUsage, usageEvents } from './usage.ts'

describe('promptUsage', () => {
  it('reads what Grok reports per model, with cost from its price ticks', () => {
    const usage = promptUsage({
      stopReason: 'end_turn',
      _meta: {
        modelId: 'grok-4.7',
        usage: {
          inputTokens: 27925,
          outputTokens: 150,
          cachedReadTokens: 1664,
          modelUsage: {
            'grok-4.7-build': {
              inputTokens: 27925,
              outputTokens: 150,
              cachedReadTokens: 1664,
              cacheCreationTokens: 0,
              costUsdTicks: 184_463_600,
            },
          },
        },
      },
    })
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      model: 'grok-4.7-build',
      // The cached part is counted apart, not twice.
      inputTokens: 26261,
      cacheReadTokens: 1664,
      outputTokens: 150,
    })
    expect(usage[0]!.costUsd).toBeCloseTo(0.01845, 4)
  })

  it("reads the protocol's own usage field", () => {
    expect(
      promptUsage({
        stopReason: 'end_turn',
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cachedReadTokens: 300,
          cachedWriteTokens: 50,
        },
      }),
    ).toEqual([
      {
        model: undefined,
        inputTokens: 700,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 50,
        costUsd: undefined,
      },
    ])
  })

  it('falls back to flat counts in _meta, naming the model when it is given', () => {
    expect(
      promptUsage({ _meta: { modelId: 'm1', inputTokens: 10, outputTokens: 5 } }),
    ).toMatchObject([{ model: 'm1', inputTokens: 10, outputTokens: 5 }])
  })

  it('says nothing when the agent reports nothing, or only zeros', () => {
    expect(promptUsage({ stopReason: 'end_turn' })).toEqual([])
    expect(promptUsage({ usage: { inputTokens: 0, outputTokens: 0 } })).toEqual([])
    expect(promptUsage(null)).toEqual([])
    expect(promptUsage('x')).toEqual([])
  })

  it('turns a report into usage events', () => {
    expect(usageEvents(promptUsage({ usage: { inputTokens: 4, outputTokens: 2 } }))).toMatchObject([
      { type: 'session.usage', inputTokens: 4, outputTokens: 2 },
    ])
  })
})
