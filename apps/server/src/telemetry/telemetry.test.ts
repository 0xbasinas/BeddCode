import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '@beddcode/shared'
import { Telemetry, httpUrl } from './telemetry.ts'

const rec = { t: 1, name: 'replay.ms', value: 5 }
const make = (over: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}) => {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }))
  const telemetry = new Telemetry({
    target: () => ({ url: 'wss://relay.example', password: 'pw' }),
    enabled: () => true,
    hostLabel: 'abc',
    log: createLogger('test', 'error'),
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...over,
  })
  return { telemetry, fetch }
}

describe('Telemetry', () => {
  it('uploads with the relay password, one batch per platform', async () => {
    const { telemetry, fetch } = make()
    expect(telemetry.report('mobile', [rec])).toBe(true)
    telemetry.record('host.replay.ms', 3)
    await telemetry.flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://relay.example/metrics')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer pw')
    expect(JSON.parse(String(init.body))).toMatchObject({ host: 'abc', platform: 'mobile' })
    telemetry.stop()
  })

  it('keeps nothing and says so while uploads are off or there is no relay', async () => {
    const off = make({ enabled: () => false })
    expect(off.telemetry.report('web', [rec])).toBe(false)
    const none = make({ target: () => undefined })
    expect(none.telemetry.report('web', [rec])).toBe(false)
    await off.telemetry.flush()
    expect(off.fetch).not.toHaveBeenCalled()
  })

  it('tries again later when the relay cannot be reached', async () => {
    const { telemetry, fetch } = make()
    fetch.mockRejectedValueOnce(new Error('offline'))
    telemetry.report('desktop', [rec])
    await telemetry.flush()
    await telemetry.flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    telemetry.stop()
  })

  it('turns a websocket address into a web one', () => {
    expect(httpUrl('wss://r.example/')).toBe('https://r.example')
    expect(httpUrl('ws://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
  })
})
