import { describe, expect, it } from 'vitest'
import {
  loadRemoteHosts,
  pairWithHost,
  parseAddress,
  peerAddresses,
  saveRemoteHosts,
  upsertHost,
  wsUrl,
  type HostEntry,
} from './hostCatalog.ts'

describe('parseAddress', () => {
  it.each([
    ['build-server', { host: 'build-server', port: 3773 }],
    ['  build-server:4000 ', { host: 'build-server', port: 4000 }],
    ['100.64.1.2', { host: '100.64.1.2', port: 3773 }],
    ['build.tail1234.ts.net', { host: 'build.tail1234.ts.net', port: 3773 }],
    ['http://build-server:3773/', { host: 'build-server', port: 3773 }],
    ['ws://100.64.1.2:3773/ws', { host: '100.64.1.2', port: 3773 }],
    ['[fd7a:115c:a1e0::1]:5000', { host: 'fd7a:115c:a1e0::1', port: 5000 }],
    ['[fd7a:115c:a1e0::1]', { host: 'fd7a:115c:a1e0::1', port: 3773 }],
  ])('reads %s', (input, expected) => {
    expect(parseAddress(input)).toEqual(expected)
  })

  it.each([
    '',
    '   ',
    'host:0',
    'host:70000',
    'host:abc',
    'two words',
    'a:b:c',
    'https://host',
    'ftp://host',
    'user@host',
    '[:::1]',
  ])('rejects %j', (input) => {
    expect(parseAddress(input)).toBeNull()
  })

  it('builds websocket URLs, bracketing IPv6', () => {
    expect(wsUrl({ host: 'build-server', port: 3773 })).toBe('ws://build-server:3773/ws')
    expect(wsUrl({ host: 'fd7a::1', port: 4000 })).toBe('ws://[fd7a::1]:4000/ws')
  })
})

describe('peerAddresses', () => {
  it('tries the MagicDNS name before the IP', () => {
    const peer = { name: 'b', dnsName: 'b.t.ts.net', ip: '100.1.2.3', online: true, os: 'linux' }
    expect(peerAddresses(peer, 4000)).toEqual([
      { host: 'b.t.ts.net', port: 4000 },
      { host: '100.1.2.3', port: 4000 },
    ])
    expect(peerAddresses({ ...peer, dnsName: '' })).toEqual([{ host: '100.1.2.3', port: 3773 }])
  })
})

describe('pairWithHost', () => {
  const host = { hostId: 'h1', name: 'build', platform: 'linux', version: '0' }
  const json = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('posts the code and device name and returns the token', async () => {
    let seen: { url: string; body: unknown } | undefined
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) }
      return new Response(JSON.stringify({ token: 't0ken', host }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await pairWithHost({ host: 'build', port: 3773 }, ' 123456 ', 'Laptop', fetchFn)
    expect(result.token).toBe('t0ken')
    expect(seen).toEqual({
      url: 'http://build:3773/pair',
      body: { code: '123456', deviceName: 'Laptop' },
    })
  })

  it("shows the host's own explanation when it refuses", async () => {
    await expect(
      pairWithHost({ host: 'b', port: 1 }, '1', 'x', json(403, { error: 'That code is wrong' })),
    ).rejects.toThrow('That code is wrong')
    await expect(pairWithHost({ host: 'b', port: 1 }, '1', 'x', json(500, {}))).rejects.toThrow(
      /500/,
    )
  })

  it('explains an unreachable host', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(pairWithHost({ host: 'b', port: 1 }, '1', 'x', down)).rejects.toThrow(
      /Could not reach b:1/,
    )
  })

  it('rejects malformed successful responses and bounds unreachable pairing attempts', async () => {
    await expect(
      pairWithHost({ host: 'b', port: 1 }, '1', 'x', json(200, { token: 'x', host: {} })),
    ).rejects.toThrow('invalid pairing response')
    let signal: AbortSignal | null | undefined
    const fetchFn = (async (_url: string, init: RequestInit) => {
      signal = init.signal
      return Response.json({ token: 'x', host })
    }) as unknown as typeof fetch
    await pairWithHost({ host: 'b', port: 1 }, '1', 'x', fetchFn)
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})

describe('saved hosts', () => {
  const entry = (key: string, extra: Partial<HostEntry> = {}): HostEntry => ({
    key,
    name: key,
    routes: [`ws://${key}:3773/ws`],
    token: 'x',
    ...extra,
  })
  const memory = () => {
    const data = new Map<string, string>()
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
  }

  it('round-trips remote hosts and never stores the local one', () => {
    const storage = memory()
    saveRemoteHosts(storage, [entry('a'), entry('local'), entry('b')])
    expect(loadRemoteHosts(storage).map((h) => h.key)).toEqual(['a', 'b'])
  })

  it('ignores missing, corrupt and malformed data', () => {
    expect(loadRemoteHosts(undefined)).toEqual([])
    expect(loadRemoteHosts(memory())).toEqual([])
    const bad = memory()
    bad.setItem('beddcode.hosts', '{nope')
    expect(loadRemoteHosts(bad)).toEqual([])
    bad.setItem(
      'beddcode.hosts',
      JSON.stringify([
        entry('ok'),
        { key: 1 },
        { key: 'x', name: 'x', routes: [] },
        entry('bad-url', { routes: ['not a URL'] }),
        entry('bad-token', { token: undefined }),
        entry('bad-scheme', { routes: ['https://host'] }),
        null,
        'str',
      ]),
    )
    expect(loadRemoteHosts(bad).map((h) => h.key)).toEqual(['ok'])
  })

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    expect(loadRemoteHosts(broken)).toEqual([])
    expect(() => saveRemoteHosts(broken, [entry('a')])).not.toThrow()
  })

  it('replaces a host that is paired again instead of listing it twice', () => {
    const list = upsertHost([entry('a'), entry('b')], entry('a', { token: 'new' }))
    expect(list.map((h) => [h.key, h.token])).toEqual([
      ['a', 'new'],
      ['b', 'x'],
    ])
    expect(upsertHost(list, entry('c')).map((h) => h.key)).toEqual(['a', 'b', 'c'])
  })
})
