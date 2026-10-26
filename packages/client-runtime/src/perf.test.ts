import { afterEach, describe, expect, it, vi } from 'vitest'
import { Recorder, startTelemetry } from './perf.ts'
import type { HostClient } from './hostClient.ts'

afterEach(() => vi.useRealTimers())

describe('Recorder', () => {
  it('keeps labels to the small alphabet and puts drained records back on failure', () => {
    const r = new Recorder()
    r.record('replay.ms', 12.345, { route: 'relay', note: '/home/me/secret' })
    expect(r.recent[0]).toMatchObject({
      name: 'replay.ms',
      value: 12.3,
      tags: { route: 'relay', note: '_home_me_secret' },
    })
    const taken = r.drain(10)
    expect(r.recent).toHaveLength(0)
    r.restore(taken)
    expect(r.recent).toHaveLength(1)
  })
})

describe('startTelemetry', () => {
  const fakeClient = (accepted: boolean) => {
    const perf = new Recorder()
    const request = vi.fn(async () => ({ accepted }))
    return { perf, request, connectionState: 'connected' } as unknown as HostClient & {
      request: typeof request
    }
  }

  it('sends measurements a few seconds after they are taken, and stops once refused', async () => {
    vi.useFakeTimers()
    const client = fakeClient(false)
    startTelemetry(client, 'mobile', { delayMs: 1000 })
    client.perf.record('replay.ms', 5)
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.request).toHaveBeenCalledTimes(1)
    client.perf.record('replay.ms', 6)
    await vi.advanceTimersByTimeAsync(5000)
    expect(client.request).toHaveBeenCalledTimes(1)
  })

  it('keeps measurements when the host cannot be reached', async () => {
    vi.useFakeTimers()
    const client = fakeClient(true)
    client.request.mockRejectedValueOnce(new Error('offline'))
    startTelemetry(client, 'web', { delayMs: 1000 })
    client.perf.record('connect.ms', 9)
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.perf.recent).toHaveLength(1)
  })
})
