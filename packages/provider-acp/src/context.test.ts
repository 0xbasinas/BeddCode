import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpEventMapper } from './mapper.ts'

const update = (used: number, size: number, cost?: { amount: number; currency: string }) =>
  ({ sessionUpdate: 'usage_update', used, size, cost }) as unknown as SessionUpdate

describe('usage_update', () => {
  it('reports how full the context window is', () => {
    const events = new AcpEventMapper('s').map(update(28_084, 256_000))
    expect(events).toMatchObject([{ type: 'session.context', used: 28_084, size: 256_000 }])
  })

  it('counts the running cost as it grows, one step at a time', () => {
    const mapper = new AcpEventMapper('s')
    const cost = (events: { type: string }[]) => events.filter((e) => e.type === 'session.usage')
    expect(cost(mapper.map(update(10, 100, { amount: 0.02, currency: 'USD' })))).toMatchObject([
      { inputTokens: 0, outputTokens: 0, costUsd: 0.02 },
    ])
    const next = cost(mapper.map(update(20, 100, { amount: 0.05, currency: 'USD' })))
    expect(next).toHaveLength(1)
    expect((next[0] as unknown as { costUsd: number }).costUsd).toBeCloseTo(0.03, 10)
    // No change, no event; and a total that went down is not a negative cost.
    expect(cost(mapper.map(update(20, 100, { amount: 0.05, currency: 'USD' })))).toEqual([])
    expect(cost(mapper.map(update(5, 100, { amount: 0.01, currency: 'USD' })))).toEqual([])
  })

  it('leaves out a cost that is not in dollars, and a window of no size', () => {
    const events = new AcpEventMapper('s').map(update(5, 0, { amount: 3, currency: 'EUR' }))
    expect(events).toEqual([])
  })

  it('does not count cost twice when each turn already reports it', () => {
    const mapper = new AcpEventMapper('s')
    mapper.noteTurnCost()
    const events = mapper.map(update(10, 100, { amount: 0.02, currency: 'USD' }))
    expect(events.map((e) => e.type)).toEqual(['session.context'])
  })

  it('treats the first total of a resumed conversation as where it starts', () => {
    const mapper = new AcpEventMapper('s')
    mapper.continuesEarlierConversation()
    expect(
      mapper.map(update(10, 100, { amount: 1.5, currency: 'USD' })).map((e) => e.type),
    ).toEqual(['session.context'])
    const after = mapper.map(update(20, 100, { amount: 1.6, currency: 'USD' }))
    expect(after.find((e) => e.type === 'session.usage')).toMatchObject({
      costUsd: expect.closeTo(0.1, 10),
    })
  })
})
