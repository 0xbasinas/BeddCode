import { ServerFrame, type PairResult } from '@beddcode/contracts'
import {
  Reassembler,
  SecureChannel,
  chunks,
  fromBase64,
  fromBase64Url,
  randomBytes,
  roomFromKey,
  toBase64,
} from './relayCrypto.ts'

/**
 * A route through a relay, kept as one string like any other address:
 * `relay+wss://relay.example.com#k=<key>`. The key is what the host and its paired devices share;
 * the room the relay sees is derived from it. The key stays in the fragment, so it is never part of
 * a request.
 */
export interface RelayRoute {
  /** The relay's base address, e.g. `wss://relay.example.com`. */
  base: string
  key: Uint8Array
  room: string
  auth: string
}

export function buildRelayRoute(base: string, key: string): string {
  return `relay+${base.replace(/\/+$/, '')}#k=${key}`
}

export function parseRelayRoute(route: string): RelayRoute | null {
  const match = /^relay\+(wss?:\/\/[^\s#@]+)#k=([A-Za-z0-9_-]{43})$/.exec(route.trim())
  if (!match) return null
  try {
    const key = fromBase64Url(match[2]!)
    if (key.length !== 32) return null
    return { base: match[1]!.replace(/\/+$/, ''), key, ...roomFromKey(key) }
  } catch {
    return null
  }
}

export const isRelayRoute = (route: string) => route.startsWith('relay+')

type Handler<T> = ((event: T) => void) | null

/**
 * What HostClient needs from a WebSocket, backed by a relay: it connects to the relay, agrees keys
 * with the host (through the relay), and from then on everything sent is encrypted. The relay can
 * neither read nor change it.
 */
export class RelaySocket {
  readyState = 0
  onopen: Handler<unknown> = null
  onmessage: Handler<{ data: string }> = null
  onclose: Handler<unknown> = null
  onerror: Handler<unknown> = null

  private ws: WebSocket
  private channel: SecureChannel | null = null
  private readonly nonce = randomBytes(16)
  private readonly pieces = new Reassembler()
  private readonly route: RelayRoute

  constructor(route: string, createSocket: (url: string) => WebSocket = (u) => new WebSocket(u)) {
    const parsed = parseRelayRoute(route)
    if (!parsed) throw new Error('Not a relay address')
    this.route = parsed
    this.ws = createSocket(`${parsed.base}/client/${parsed.room}`)
    this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'hi', n: toBase64(this.nonce) }))
    this.ws.onmessage = (msg) => this.receive(String(msg.data))
    this.ws.onclose = () => this.closed()
    this.ws.onerror = () => this.onerror?.({})
  }

  send(data: string) {
    if (!this.channel || this.readyState !== 1) throw new Error('relay not connected')
    const sealed = this.channel.seal(data)
    for (const part of chunks(sealed)) this.ws.send(JSON.stringify({ t: 'm', d: part.d, f: part.f }))
  }

  close() {
    this.ws.close()
    this.closed()
  }

  private closed() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({})
  }

  private receive(text: string) {
    let frame: { t?: string; n?: string; d?: string; f?: boolean }
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    try {
      if (frame.t === 'hi' && !this.channel && typeof frame.n === 'string') {
        this.channel = new SecureChannel(
          this.route.key,
          this.nonce,
          fromBase64(frame.n),
          'client',
        )
        this.readyState = 1
        this.onopen?.({})
      } else if (frame.t === 'm' && this.channel && typeof frame.d === 'string') {
        const whole = this.pieces.push(frame.d, frame.f === true)
        if (whole !== null) this.onmessage?.({ data: this.channel.open(whole) })
      }
    } catch {
      // A message that does not decrypt means the other end does not hold the key (or someone is
      // interfering): drop the connection rather than trust anything on it.
      this.ws.close()
      this.closed()
    }
  }
}

/** Pairs with a host through a relay: connects, sends the one-time code, and returns its answer. */
export function pairViaRelay(
  route: string,
  code: string,
  deviceName: string,
  createSocket?: (url: string) => WebSocket,
  timeoutMs = 10_000,
): Promise<PairResult> {
  return new Promise((resolve, reject) => {
    let socket: RelaySocket
    try {
      socket = new RelaySocket(route, createSocket)
    } catch (err) {
      return reject(err)
    }
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.close()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('The relay did not reach the host. Is it running?'))),
      timeoutMs,
    )
    socket.onopen = () => socket.send(JSON.stringify({ t: 'pair', code: code.trim(), deviceName }))
    socket.onmessage = (msg) => {
      let frame: ServerFrame
      try {
        frame = ServerFrame.parse(JSON.parse(msg.data))
      } catch {
        return
      }
      if (frame.t === 'paired')
        finish(() => resolve({ token: frame.token, host: frame.host }))
      else if (frame.t === 'pair.failed') finish(() => reject(new Error(frame.error)))
    }
    socket.onclose = () =>
      finish(() => reject(new Error('The relay could not reach the host. Is it running?')))
  })
}

