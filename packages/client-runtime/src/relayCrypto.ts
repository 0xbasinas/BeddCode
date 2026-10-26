import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { deflateSync, inflateSync } from 'fflate'
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

const B64_CODES = Array.from(B64, (ch) => ch.charCodeAt(0))
/** Character code to 6-bit value; 255 marks a character that is not base64. */
const B64_VALUE = new Uint8Array(128).fill(255)
B64_CODES.forEach((code, value) => (B64_VALUE[code] = value))

export function toBase64(bytes: Uint8Array): string {
  // Built in slices of char codes: far quicker than one string append per character on a phone.
  const parts: string[] = []
  const SLICE = 3 * 4096
  for (let start = 0; start < bytes.length; start += SLICE) {
    const end = Math.min(bytes.length, start + SLICE)
    const codes: number[] = []
    for (let i = start; i < end; i += 3) {
      const a = bytes[i]!
      const b = bytes[i + 1]
      const c = bytes[i + 2]
      codes.push(
        B64_CODES[a >> 2]!,
        B64_CODES[((a & 3) << 4) | ((b ?? 0) >> 4)]!,
        b === undefined ? 61 : B64_CODES[((b & 15) << 2) | ((c ?? 0) >> 6)]!,
        c === undefined ? 61 : B64_CODES[c & 63]!,
      )
    }
    parts.push(String.fromCharCode.apply(null, codes))
  }
  return parts.join('')
}

export function fromBase64(text: string): Uint8Array {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 61) end--
  const out = new Uint8Array(Math.floor((end * 3) / 4))
  let bits = 0
  let acc = 0
  let o = 0
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i)
    const value = code < 128 ? B64_VALUE[code]! : 255
    if (value === 255) throw new Error('bad base64')
    acc = ((acc << 6) | value) & 0xffffff
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

/** First byte of a message that was compressed before it was encrypted. */
const ZIPPED = 1
/** Messages shorter than this are sent as they are: compressing them gains nothing. */
const COMPRESS_FROM = 512

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

  /**
   * Encrypts one message; the result is base64 text safe to put in a JSON frame. With `compress`
   * a message of any size worth it is squeezed first (the other end must be able to open it, which
   * `open` always can). Text never starts with byte 1, so that byte marks a squeezed message.
   */
  seal(text: string, compress = false): string {
    const nonce = SecureChannel.nonce(this.sent++)
    let plain = enc.encode(text)
    if (compress && plain.length >= COMPRESS_FROM) {
      const packed = deflateSync(plain, { level: 6 })
      if (packed.length + 1 < plain.length) {
        const marked = new Uint8Array(packed.length + 1)
        marked[0] = ZIPPED
        marked.set(packed, 1)
        plain = marked
      }
    }
    return toBase64(chacha20poly1305(this.sendKey, nonce).encrypt(plain))
  }

  /** Decrypts the next message. Throws when it was altered, replayed, or arrived out of order. */
  open(data: string): string {
    const nonce = SecureChannel.nonce(this.received)
    const plain = chacha20poly1305(this.recvKey, nonce).decrypt(fromBase64(data))
    this.received++
    return dec.decode(plain[0] === ZIPPED ? inflateSync(plain.subarray(1)) : plain)
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
