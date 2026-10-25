import { describe, expect, it } from 'vitest'
import { buildPairLink, parsePairLink, pairWithLink } from './pairLink.ts'
import { newRelayKey } from './relayCrypto.ts'
import { buildRelayRoute } from './relaySocket.ts'

const link = {
  code: '123456',
  name: 'Desk PC',
  hostId: 'host-1',
  routes: ['ws://desk.tail.ts.net:3773/ws', 'ws://192.168.1.4:3773/ws'],
}

describe('pair links', () => {
  it('round-trips through build and parse', () => {
    const relay = buildRelayRoute('wss://r.example', newRelayKey())
    const text = buildPairLink({ ...link, relay })
    expect(text.startsWith('beddcode://pair?')).toBe(true)
    expect(parsePairLink(text)).toEqual({ ...link, relay })
  })

  it('rejects other text, bad codes, and links with nowhere to connect', () => {
    expect(parsePairLink('https://example.com')).toBeNull()
    expect(parsePairLink('beddcode://pair?c=12&r=ws://a:1/ws')).toBeNull()
    expect(parsePairLink('beddcode://pair?c=123456')).toBeNull()
    expect(parsePairLink('beddcode://pair?c=123456&r=javascript:alert(1)')).toBeNull()
    expect(parsePairLink('beddcode://pair?c=123456&r=ws://user:pw@a:1/ws')).toBeNull()
  })

  it('pairs on the first address that answers, and keeps every route', async () => {
    const calls: string[] = []
    const fetchFn = (async (url: string) => {
      calls.push(url)
      if (url.includes('desk.tail')) throw new Error('offline')
      return new Response(
        JSON.stringify({
          token: 'tok',
          host: { hostId: 'host-1', name: 'Desk PC', platform: 'linux', version: '1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const entry = await pairWithLink(link, 'Phone', fetchFn)
    expect(calls).toHaveLength(2)
    expect(entry).toMatchObject({ key: 'host-1', token: 'tok', routes: link.routes })
  })

  it('stops at a refused code instead of trying the other addresses', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: 'Wrong or expired code' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    await expect(pairWithLink(link, 'Phone', fetchFn)).rejects.toThrow('Wrong or expired code')
  })
})
