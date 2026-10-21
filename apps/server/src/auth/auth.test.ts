import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyPeer, defaultGuard, needsToken, originAllowed, peerAllowed } from './guard.ts'
import { PairingManager } from './pairing.ts'
import { TokenStore } from './tokens.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beddcode-auth-'))
  dirs.push(d)
  return d
}

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
