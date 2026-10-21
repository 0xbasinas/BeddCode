import { describe, expect, it } from 'vitest'
import { isLoopbackHost, parseServeArgs } from './config.ts'

describe('parseServeArgs', () => {
  it('defaults to loopback, port 3773 and the safe guard', () => {
    const c = parseServeArgs([], {})
    expect(c).toMatchObject({ port: 3773, host: '127.0.0.1' })
    expect(c.guard).toEqual({ requireToken: false, allowLan: false, allowedOrigins: [] })
  })

  it('reads environment variables, and flags override them', () => {
    const env = {
      BEDDCODE_PORT: '4000',
      BEDDCODE_HOST: '0.0.0.0',
      BEDDCODE_ALLOW_LAN: '1',
      BEDDCODE_REQUIRE_TOKEN: 'true',
      BEDDCODE_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    }
    const fromEnv = parseServeArgs([], env)
    expect(fromEnv).toMatchObject({ port: 4000, host: '0.0.0.0' })
    expect(fromEnv.guard).toEqual({
      requireToken: true,
      allowLan: true,
      allowedOrigins: ['https://a.example', 'https://b.example'],
    })
    const flags = parseServeArgs(
      ['--port', '5000', '--host', '::', '--allow-origin', 'https://c.example'],
      env,
    )
    expect(flags).toMatchObject({ port: 5000, host: '::' })
    expect(flags.guard.allowedOrigins).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ])
  })

  it('rejects unknown options, missing values and bad ports', () => {
    expect(() => parseServeArgs(['--wat'], {})).toThrow(/Unknown option/)
    expect(() => parseServeArgs(['--port'], {})).toThrow(/needs a value/)
    expect(() => parseServeArgs(['--port', 'abc'], {})).toThrow(/Invalid port/)
    expect(() => parseServeArgs(['--port', '70000'], {})).toThrow(/Invalid port/)
  })

  it('knows which addresses stay on this machine', () => {
    expect(['127.0.0.1', 'localhost', '::1', '127.1.2.3'].every(isLoopbackHost)).toBe(true)
    expect(['0.0.0.0', '::', '100.1.2.3', '192.168.1.5'].some(isLoopbackHost)).toBe(false)
  })
})
