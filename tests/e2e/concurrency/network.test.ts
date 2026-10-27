import { describe, expect, it } from 'vitest'
import { networkDelta, type NetworkSnapshot } from './network.ts'

const snapshot = (at: string, receivedBytes: number, sentBytes: number): NetworkSnapshot => ({
  at,
  interfaces: [{ id: 'wifi', name: 'WiFi', type: 'Wireless80211', receivedBytes, sentBytes }],
})

describe('network counter deltas', () => {
  it('computes bytes and average rates across the snapshot interval', () => {
    const result = networkDelta(
      snapshot('2026-01-01T00:00:00Z', 100, 200),
      snapshot('2026-01-01T00:00:02Z', 300, 500),
    )
    expect(result.interfaces[0]).toMatchObject({
      receivedBytes: 200,
      sentBytes: 300,
      averageReceiveBytesPerSecond: 100,
      averageSendBytesPerSecond: 150,
    })
  })

  it('omits counters that reset instead of reporting negative traffic', () => {
    expect(
      networkDelta(
        snapshot('2026-01-01T00:00:00Z', 100, 200),
        snapshot('2026-01-01T00:00:01Z', 50, 300),
      ).interfaces,
    ).toEqual([])
  })

  it('preserves errors instead of inventing a measurement', () => {
    const before: NetworkSnapshot = {
      at: '2026-01-01T00:00:00Z',
      interfaces: [],
      error: 'Unavailable',
    }
    expect(networkDelta(before, snapshot('2026-01-01T00:00:01Z', 100, 200))).toMatchObject({
      error: 'Unavailable',
      interfaces: [],
    })
  })
})
