import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

/**
 * The end-to-end encryption between a host and a device that reach each other through a relay.
 * The relay only ever sees the room name and ciphertext. Both sides know one 32-byte key from
 * pairing; each connection mixes in fresh nonces from both ends, so keys and message numbers never
 * repeat, and a message that is replayed, dropped or reordered is refused.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

export function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (!c?.getRandomValues) throw new Error('This device has no secure random number source')
  return c.getRandomValues(new Uint8Array(n))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!
    out += c === undefined ? '=' : B64[c & 63]!
  }
  return out
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  if (/[^A-Za-z0-9+/]/.test(clean)) throw new Error('bad base64')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let acc = 0
  let o = 0
  for (const ch of clean) {
    acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 255
    }
  }
  return out
}

export const toBase64Url = (b: Uint8Array) =>
  toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const fromBase64Url = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  return fromBase64(t + '='.repeat((4 - (t.length % 4)) % 4))
}

export const newRelayKey = () => toBase64Url(randomBytes(32))

const derive = (key: Uint8Array, info: string, length: number, salt?: Uint8Array) =>
  hkdf(sha256, key, salt, enc.encode(`beddcode-relay-v1:${info}`), length)

/**
 * Everything the relay may know about a host, derived from its key: the room where it meets
 * devices, and the proof that it owns that room. The key itself never leaves the paired devices.
 */
export function roomFromKey(key: Uint8Array): { room: string; auth: string } {
  return {
    room: toBase64Url(derive(key, 'room', 16)),
    auth: toBase64Url(sha256(derive(key, 'host-auth', 32))),
  }
}

export type Role = 'client' | 'host'

/** One connection's two directions of encrypted messages. */
export class SecureChannel {
  private sendKey: Uint8Array
  private recvKey: Uint8Array
  private sent = 0
  private received = 0

  constructor(key: Uint8Array, clientNonce: Uint8Array, hostNonce: Uint8Array, role: Role) {
    const salt = new Uint8Array(clientNonce.length + hostNonce.length)
    salt.set(clientNonce)
    salt.set(hostNonce, clientNonce.length)
    const keys = derive(key, 'session', 64, salt)
    const c2h = keys.slice(0, 32)
    const h2c = keys.slice(32)
    this.sendKey = role === 'client' ? c2h : h2c
    this.recvKey = role === 'client' ? h2c : c2h
  }

  private static nonce(counter: number): Uint8Array {
    const n = new Uint8Array(12)
    new DataView(n.buffer).setBigUint64(4, BigInt(counter))
    return n
  }

  /** Encrypts one message; the result is base64 text safe to put in a JSON frame. */
  seal(text: string): string {
    const nonce = SecureChannel.nonce(this.sent++)
    return toBase64(chacha20poly1305(this.sendKey, nonce).encrypt(enc.encode(text)))
  }

  /** Decrypts the next message. Throws when it was altered, replayed, or arrived out of order. */
  open(data: string): string {
    const nonce = SecureChannel.nonce(this.received)
    const plain = chacha20poly1305(this.recvKey, nonce).decrypt(fromBase64(data))
    this.received++
    return dec.decode(plain)
  }
}

/** Frames bigger than this are split, so a relay's message size limit never matters. */
export const CHUNK = 48 * 1024

export function chunks(data: string): { d: string; f: boolean }[] {
  if (data.length <= CHUNK) return [{ d: data, f: false }]
  const out: { d: string; f: boolean }[] = []
  for (let i = 0; i < data.length; i += CHUNK)
    out.push({ d: data.slice(i, i + CHUNK), f: i + CHUNK < data.length })
  return out
}

/** Puts split frames back together, one stream per sender. */
export class Reassembler {
  private parts: string[] = []
  private size = 0
  constructor(private readonly maxChars = 64 * 1024 * 1024) {}

  /** The whole message once its last piece arrives, else null. */
  push(d: string, more: boolean): string | null {
    this.size += d.length
    if (this.size > this.maxChars) {
      this.parts = []
      this.size = 0
      throw new Error('relay message too large')
    }
    if (more) {
      this.parts.push(d)
      return null
    }
    const whole = this.parts.length ? this.parts.join('') + d : d
    this.parts = []
    this.size = 0
    return whole
  }
}
