import { describe, expect, it } from 'vitest'
import {
  Reassembler,
  SecureChannel,
  chunks,
  fromBase64,
  fromBase64Url,
  newRelayKey,
  randomBytes,
  roomFromKey,
  toBase64,
  toBase64Url,
} from './relayCrypto.ts'

const pair = () => {
  const key = fromBase64Url(newRelayKey())
  const nc = randomBytes(16)
  const nh = randomBytes(16)
  return {
    client: new SecureChannel(key, nc, nh, 'client'),
    host: new SecureChannel(key, nc, nh, 'host'),
    key,
    nc,
    nh,
  }
}

describe('relay crypto', () => {
  it('round-trips base64 for any length', () => {
    for (let n = 0; n < 40; n++) {
      const b = randomBytes(n)
      expect([...fromBase64(toBase64(b))]).toEqual([...b])
      expect([...fromBase64Url(toBase64Url(b))]).toEqual([...b])
    }
    expect(toBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=')
  })

  it('encodes base64 the way Node does, for big inputs too', () => {
    const big = new Uint8Array(200_003)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 255
    expect(toBase64(big)).toBe(Buffer.from(big).toString('base64'))
    expect([...fromBase64(Buffer.from(big).toString('base64'))]).toEqual([...big])
    expect(() => fromBase64('ab$d')).toThrow()
    expect(() => fromBase64('abcé')).toThrow()
  })

  it('compresses what is worth compressing, and any end can open it', () => {
    const { client, host } = pair()
    const text = JSON.stringify({
      t: 'events',
      events: Array(300).fill({ out: 'line of output ' }),
    })
    const plain = client.seal(text)
    const packed = host.seal(text, true)
    expect(packed.length).toBeLessThan(plain.length / 4)
    // The other end opens it without being told: a squeezed message marks itself.
    expect(client.open(packed)).toBe(text)
    expect(host.open(plain)).toBe(text)
    // Short messages are left alone, and unicode survives.
    const tiny = host.seal('ok ✓', true)
    expect(client.open(tiny)).toBe('ok ✓')
  })

  it('carries messages both ways, in order', () => {
    const { client, host } = pair()
    expect(host.open(client.seal('one'))).toBe('one')
    expect(host.open(client.seal('two'))).toBe('two')
    expect(client.open(host.seal('back ✓'))).toBe('back ✓')
  })

  it('refuses replayed, reordered, altered and wrong-key messages', () => {
    const { client, host, key, nc, nh } = pair()
    const a = client.seal('a')
    const b = client.seal('b')
    expect(() => host.open(b)).toThrow()
    expect(host.open(a)).toBe('a')
    expect(() => host.open(a)).toThrow()
    expect(host.open(b)).toBe('b')

    const tampered = client.seal('c')
    const bytes = fromBase64(tampered)
    bytes[0]! ^= 1
    expect(() => host.open(toBase64(bytes))).toThrow()

    const other = new SecureChannel(fromBase64Url(newRelayKey()), nc, nh, 'host')
    expect(() => other.open(new SecureChannel(key, nc, nh, 'client').seal('x'))).toThrow()
  })

  it('does not let a message be bounced back to its sender', () => {
    const { client } = pair()
    expect(() => client.open(client.seal('x'))).toThrow()
  })

  it('derives the same room for a key, and a different one per key', () => {
    const key = fromBase64Url(newRelayKey())
    expect(roomFromKey(key)).toEqual(roomFromKey(key))
    expect(roomFromKey(key).room).not.toBe(roomFromKey(fromBase64Url(newRelayKey())).room)
    expect(roomFromKey(key).auth).not.toBe(roomFromKey(key).room)
  })

  it('splits and rejoins large messages', () => {
    const big = 'x'.repeat(150_000)
    const parts = chunks(big)
    expect(parts.length).toBe(4)
    expect(parts.slice(0, -1).every((p) => p.f)).toBe(true)
    const r = new Reassembler()
    let whole: string | null = null
    for (const p of parts) whole = r.push(p.d, p.f)
    expect(whole).toBe(big)
    expect(() => new Reassembler(10).push('x'.repeat(20), true)).toThrow()
  })
})
