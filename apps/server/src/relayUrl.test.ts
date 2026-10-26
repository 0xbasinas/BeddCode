import { describe, expect, it } from 'vitest'
import { normalizeRelayUrl } from './config.ts'

describe('normalizeRelayUrl', () => {
  it('turns an ordinary address into the websocket one', () => {
    expect(normalizeRelayUrl('relay.example.com')).toBe('wss://relay.example.com')
    expect(normalizeRelayUrl('https://relay.example.com/')).toBe('wss://relay.example.com')
    expect(normalizeRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com')
    expect(normalizeRelayUrl('http://192.168.1.5:8787')).toBe('ws://192.168.1.5:8787')
  })
  it('rejects things that are not a bare address', () => {
    expect(() => normalizeRelayUrl('https://relay.example.com/path')).toThrow()
    expect(() => normalizeRelayUrl('ftp://relay.example.com')).toThrow()
    expect(() => normalizeRelayUrl('')).toThrow()
  })
})
