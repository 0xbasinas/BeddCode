import { describe, expect, it } from 'vitest'
import { localHostUrl } from './localHostUrl.ts'

describe('localHostUrl', () => {
  it('talks back to the host that served the built app', () => {
    expect(
      localHostUrl({ dev: false, location: { protocol: 'http:', host: '127.0.0.1:3773' } }),
    ).toBe('ws://127.0.0.1:3773/ws')
    expect(
      localHostUrl({
        dev: false,
        location: { protocol: 'http:', host: 'build.tail1234.ts.net:3773' },
      }),
    ).toBe('ws://build.tail1234.ts.net:3773/ws')
    expect(
      localHostUrl({ dev: false, location: { protocol: 'https:', host: 'host.example' } }),
    ).toBe('wss://host.example/ws')
  })

  it('uses the usual local host while developing, and when opened from disk', () => {
    expect(
      localHostUrl({ dev: true, location: { protocol: 'http:', host: 'localhost:5173' } }),
    ).toBe('ws://127.0.0.1:3773/ws')
    expect(localHostUrl({ dev: false, location: { protocol: 'file:', host: '' } })).toBe(
      'ws://127.0.0.1:3773/ws',
    )
    expect(localHostUrl({ dev: false })).toBe('ws://127.0.0.1:3773/ws')
  })

  it('lets an explicit address win over everything', () => {
    expect(
      localHostUrl({
        override: 'ws://10.0.0.5:3773/ws',
        dev: false,
        location: { protocol: 'http:', host: 'x:1' },
      }),
    ).toBe('ws://10.0.0.5:3773/ws')
  })
})
