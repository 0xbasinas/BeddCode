import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyPeer,
  classifyRequest,
  defaultGuard,
  forwardedAddress,
  needsToken,
  originAllowed,
  peerAllowed,
} from './guard.ts'
import { PairingManager } from './pairing.ts'
import { TokenStore } from './tokens.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beddcode-auth-'))
  dirs.push(d)
  return d
}

describe('classifyRequest (reverse proxies)', () => {
  it('keeps this machine trusted when no proxy is involved', () => {
    expect(
      classifyRequest('127.0.0.1', { host: '127.0.0.1:3773', origin: 'http://127.0.0.1:3773' }),
    ).toBe('loopback')
  })

  it('classifies Tailscale Serve traffic by the relayed tailnet address, so it needs a token', () => {
    const peer = classifyRequest('127.0.0.1', {
      'x-forwarded-for': '100.101.1.2',
      'x-forwarded-host': 'box.tail.ts.net:3773',
      'tailscale-user-login': 'me@example.com',
    })
    expect(peer).toBe('tailnet')
    expect(needsToken(peer, defaultGuard())).toBe(true)
    expect(peerAllowed(peer, defaultGuard())).toBe(true)
  })

  it('treats a tailnet identity without an address as a tailnet peer', () => {
    expect(classifyRequest('::1', { 'tailscale-user-login': 'me@example.com' })).toBe('tailnet')
  })

  it('refuses Funnel (internet) traffic and unknown relayed peers', () => {
    expect(
      classifyRequest('127.0.0.1', {
        'tailscale-funnel-request': '?1',
        'x-forwarded-for': '100.64.0.9',
      }),
    ).toBe('other')
    expect(classifyRequest('127.0.0.1', { 'x-forwarded-for': '8.8.8.8' })).toBe('other')
    expect(classifyRequest('127.0.0.1', { via: '1.1 proxy' })).toBe('other')
    expect(peerAllowed('other', defaultGuard())).toBe(false)
  })

  it('never grants loopback trust through a proxy, even for a relayed local address', () => {
    expect(classifyRequest('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })).toBe('other')
    expect(classifyRequest('127.0.0.1', { 'x-real-ip': '::1' })).toBe('other')
  })

  it('trusts only the rightmost forwarded address (the one the local proxy added)', () => {
    expect(forwardedAddress({ 'x-forwarded-for': '127.0.0.1, 100.70.0.5' })).toBe('100.70.0.5')
    expect(classifyRequest('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 192.168.1.4' })).toBe(
      'lan',
    )
    expect(forwardedAddress({ forwarded: 'for=127.0.0.1, for="[fd7a:115c:a1e0::5]:443"' })).toBe(
      'fd7a:115c:a1e0::5',
    )
    expect(forwardedAddress({ 'x-real-ip': '100.70.0.5:1234' })).toBe('100.70.0.5')
  })

  it('ignores proxy headers from peers that are not this machine', () => {
    expect(classifyRequest('100.80.0.1', { 'x-forwarded-for': '127.0.0.1' })).toBe('tailnet')
    expect(classifyRequest('8.8.8.8', { 'x-forwarded-for': '100.80.0.1' })).toBe('other')
  })
})

describe('classifyPeer', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['100.102.226.6', 'tailnet'],
    ['100.64.0.1', 'tailnet'],
    ['100.127.255.254', 'tailnet'],
    ['::ffff:100.101.1.1', 'tailnet'],
    ['fd7a:115c:a1e0::e33a:e207', 'tailnet'],
    ['192.168.10.104', 'lan'],
    ['10.1.2.3', 'lan'],
    ['172.16.0.9', 'lan'],
    ['172.31.255.1', 'lan'],
    ['fe80::1', 'lan'],
    ['100.63.0.1', 'other'],
    ['100.128.0.1', 'other'],
    ['172.32.0.1', 'other'],
    ['8.8.8.8', 'other'],
    ['2001:4860:4860::8888', 'other'],
    ['', 'other'],
    [undefined, 'other'],
  ])('%s is %s', (address, expected) => {
    expect(classifyPeer(address)).toBe(expected)
  })
})

describe('guard rules', () => {
  it('accepts this machine and the tailnet, and a LAN only when allowed', () => {
    const guard = defaultGuard()
    expect(peerAllowed('loopback', guard)).toBe(true)
    expect(peerAllowed('tailnet', guard)).toBe(true)
    expect(peerAllowed('lan', guard)).toBe(false)
    expect(peerAllowed('other', guard)).toBe(false)
    expect(peerAllowed('lan', { ...guard, allowLan: true })).toBe(true)
    expect(peerAllowed('other', { ...guard, allowLan: true })).toBe(false)
  })

  it('trusts only the machine itself without a token', () => {
    const guard = defaultGuard()
    expect(needsToken('loopback', guard)).toBe(false)
    expect(needsToken('tailnet', guard)).toBe(true)
    expect(needsToken('lan', { ...guard, allowLan: true })).toBe(true)
    expect(needsToken('loopback', { ...guard, requireToken: true })).toBe(true)
  })

  it('lets pages from this machine connect but not pages from the internet', () => {
    const guard = defaultGuard()
    expect(originAllowed(undefined, guard)).toBe(true)
    expect(originAllowed('http://localhost:5173', guard)).toBe(true)
    expect(originAllowed('http://127.0.0.1:3773', guard)).toBe(true)
    expect(originAllowed('http://[::1]:3773', guard)).toBe(true)
    expect(originAllowed('https://evil.example', guard)).toBe(false)
    expect(originAllowed('http://localhost.evil.example', guard)).toBe(false)
    expect(originAllowed('http://127.0.0.1.evil.example:3773', guard)).toBe(false)
    expect(originAllowed('null', guard)).toBe(false)
    expect(originAllowed('file://', guard)).toBe(false)
    expect(
      originAllowed('https://app.example', { ...guard, allowedOrigins: ['https://app.example'] }),
    ).toBe(true)
  })

  it('lets an app connect to the address it was given, but never a page on another site', () => {
    const guard = defaultGuard()
    // React Native sends an Origin made from the URL it connected to.
    expect(originAllowed('http://100.64.0.12:3773', guard, '100.64.0.12:3773')).toBe(true)
    expect(originAllowed('http://pc.tail1234.ts.net:3773', guard, 'pc.tail1234.ts.net:3773')).toBe(
      true,
    )
    expect(
      originAllowed('http://[fd7a:115c:a1e0::1]:3773', guard, '[fd7a:115c:a1e0::1]:3773'),
    ).toBe(true)
    // A name an attacker controls can be made to point here (DNS rebinding): still refused.
    expect(originAllowed('http://evil.example:3773', guard, 'evil.example:3773')).toBe(false)
    // Origin and Host must agree.
    expect(originAllowed('http://evil.example', guard, '100.64.0.12:3773')).toBe(false)
    expect(originAllowed('http://100.64.0.12:3773', guard)).toBe(false)
  })
})

describe('TokenStore', () => {
  it('issues a token once, verifies it, and never stores it in clear', () => {
    const file = path.join(tmp(), 'auth.json')
    const store = new TokenStore(file)
    const { token, device } = store.issue('Georgios laptop')
    expect(token.length).toBeGreaterThan(30)
    expect(store.verify(token)).toMatchObject({ id: device.id, name: 'Georgios laptop' })
    expect(store.verify(token + 'x')).toBeNull()
    expect(store.verify(undefined)).toBeNull()
    expect(store.verify('')).toBeNull()

    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toContain(token)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0)
  })

  it('survives a restart, tracks use, and revokes', () => {
    const file = path.join(tmp(), 'auth.json')
    let now = 1_000
    const a = new TokenStore(file, () => now)
    const { token, device } = a.issue('Phone')
    now = 500_000
    a.verify(token)

    const b = new TokenStore(file, () => now)
    expect(b.list()).toEqual([
      { id: device.id, name: 'Phone', createdAt: 1_000, lastUsedAt: 500_000 },
    ])
    expect(b.verify(token)?.id).toBe(device.id)
    expect(b.revoke(device.id)).toBe(true)
    expect(b.revoke(device.id)).toBe(false)
    expect(b.verify(token)).toBeNull()
    expect(new TokenStore(file).list()).toEqual([])
  })

  it('names unnamed devices and trims long names', () => {
    const store = new TokenStore(path.join(tmp(), 'auth.json'))
    expect(store.issue('   ').device.name).toBe('Unnamed device')
    expect(store.issue('x'.repeat(200)).device.name).toHaveLength(80)
  })
})

describe('PairingManager', () => {
  it('creates six-digit codes that work once', () => {
    const pairing = new PairingManager()
    const { code, expiresAt } = pairing.create()
    expect(code).toMatch(/^\d{6}$/)
    expect(expiresAt).toBeGreaterThan(Date.now())
    expect(pairing.redeem(code)).toBe('ok')
    expect(pairing.redeem(code)).toBe('invalid')
  })

  it('pads short codes and never repeats one that is still valid', () => {
    const sequence = [42, 42, 7]
    const pairing = new PairingManager(
      () => 0,
      () => sequence.shift()!,
    )
    expect(pairing.create().code).toBe('000042')
    expect(pairing.create().code).toBe('000007')
  })

  it('expires codes after ten minutes', () => {
    let now = 0
    const pairing = new PairingManager(() => now)
    const { code } = pairing.create()
    now = 10 * 60_000 + 1
    expect(pairing.redeem(code)).toBe('invalid')
  })

  it('locks out guessing: five wrong tries burn every open code and pause redeeming', () => {
    let now = 0
    const pairing = new PairingManager(
      () => now,
      () => 123456,
    )
    const { code } = pairing.create()
    for (let i = 0; i < 4; i++) expect(pairing.redeem('000000')).toBe('invalid')
    expect(pairing.redeem('000000')).toBe('locked')
    // Even the right code is refused while locked, and it no longer exists afterwards.
    expect(pairing.redeem(code)).toBe('locked')
    now = 61_000
    expect(pairing.redeem(code)).toBe('invalid')
    expect(pairing.redeem('000001')).toBe('invalid')
  })

  it('forgives slow, spread-out mistakes', () => {
    let now = 0
    const pairing = new PairingManager(() => now)
    for (let i = 0; i < 10; i++) {
      now += 61_000
      expect(pairing.redeem('999999')).toBe('invalid')
    }
  })
})
