import { describe, expect, it, vi } from 'vitest'
import { formatSummary, metricsCmd } from './metrics.ts'

const summary = {
  days: 7,
  samples: 12,
  rows: [
    {
      name: 'replay.ms',
      platform: 'mobile',
      route: 'relay',
      count: 3,
      p50: 840,
      p95: 1200.4,
      max: 1300,
      avg: 900,
    },
  ],
}
const fakeIo = () => {
  const out: string[] = []
  return {
    io: { out: (t: string) => out.push(t), err() {}, interactive: false, ask: async () => '' },
    out,
  }
}

describe('metrics', () => {
  it('prints a table and says what the figures are', () => {
    const text = formatSummary(summary)
    expect(text).toContain('replay.ms')
    expect(text).toMatch(/mobile\s+relay\s+3\s+840\s+1200\s+1300/)
    expect(formatSummary({ days: 1, samples: 0, rows: [] })).toContain('No measurements')
  })

  it('asks the relay with its password', async () => {
    const { io, out } = fakeIo()
    const fetchFn = vi.fn(async () => Response.json(summary))
    await metricsCmd(['--days', '3'], io, fetchFn as unknown as typeof fetch, {
      relayUrl: 'wss://r.example',
      relayPassword: 'pw',
    })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://r.example/metrics/summary?days=3')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer pw')
    expect(out.join('')).toContain('replay.ms')
  })

  it('explains what is missing', async () => {
    const { io } = fakeIo()
    await expect(metricsCmd([], io, fetch, {})).rejects.toThrow(/relay/)
    const denied = vi.fn(async () => new Response(null, { status: 401 }))
    await expect(
      metricsCmd([], io, denied as unknown as typeof fetch, {
        relayUrl: 'r.example',
        relayPassword: 'x',
      }),
    ).rejects.toThrow(/password/)
  })
})
