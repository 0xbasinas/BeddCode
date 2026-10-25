import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { Logger } from '@beddcode/shared'
import {
  Reassembler,
  SecureChannel,
  chunks,
  fromBase64,
  fromBase64Url,
  randomBytes,
  roomFromKey,
  toBase64,
} from '@beddcode/client-runtime/relayCrypto'
import type { ConnSocket } from '../transport/server.ts'

/** What the relay says to a host (see packages/relay/src/protocol.ts). */
type FromRelay =
  | { t: 'ready' }
  | { t: 'open'; c: string }
  | { t: 'close'; c: string }
  | { t: 'hi'; c: string; n: string }
  | { t: 'm'; c: string; d: string; f?: boolean }

/** A device that reached this host through the relay, shaped like a socket so the host serves it like any other. */
class DeviceSocket extends EventEmitter implements ConnSocket {
  readonly OPEN = 1
  readyState = 0
  channel?: SecureChannel
  readonly pieces = new Reassembler()

  constructor(
    private readonly out: (frame: object) => void,
    private readonly buffered: () => number,
    private readonly cid: string,
    private readonly onGone: () => void,
  ) {
    super()
  }

  get bufferedAmount() {
    return this.buffered()
  }

  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  send(data: string) {
    if (!this.channel || this.readyState !== 1) return
    for (const part of chunks(this.channel.seal(data)))
      this.out({ t: 'm', c: this.cid, d: part.d, f: part.f })
  }

  close() {
    if (this.readyState === 3) return
    this.out({ t: 'close', c: this.cid })
    this.gone()
  }

  /** The relay, or the device, ended it. */
  gone() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onGone()
    this.emit('close')
  }

  terminate() {
    this.close()
  }

  /** The relay keeps its own keep-alive; a device that goes quiet is closed by the host's heartbeat. */
  ping() {}
}

export interface RelayAgentOptions {
  /** The relay's address, e.g. `wss://relay.example.com`. */
  url: string
  /** The 32-byte key this host shares with its paired devices (base64url). */
  key: string
  /** Serves a device connection. */
  attach(socket: ConnSocket): void
  log: Logger
  /** Wait between reconnects, doubling up to `maxMs`. */
  backoff?: { minMs: number; maxMs: number }
  /** How often to check the relay still answers. */
  heartbeatMs?: number
}

export type RelayStatus = 'connecting' | 'online' | 'offline' | 'stopped'

/**
 * Keeps this host reachable through a relay: it connects out (so no port needs opening), claims
 * its room, and for each device that shows up agrees keys and serves it like a local connection.
 * Everything between the device and this host is end-to-end encrypted; the relay forwards bytes.
 */
export class RelayAgent {
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private awaitingPong = false
  private stopped = false
  private readonly devices = new Map<string, DeviceSocket>()
  private readonly key: Uint8Array
  private readonly room: { room: string; auth: string }
  status: RelayStatus = 'connecting'

  constructor(private readonly options: RelayAgentOptions) {
    this.key = fromBase64Url(options.key)
    if (this.key.length !== 32) throw new Error('The relay key must be 32 bytes')
    this.room = roomFromKey(this.key)
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    this.status = 'stopped'
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dropConnection()
  }

  private connect() {
    if (this.stopped) return
    this.status = 'connecting'
    const ws = new WebSocket(`${this.options.url.replace(/\/+$/, '')}/host/${this.room.room}`)
    this.ws = ws
    ws.on('open', () => ws.send(JSON.stringify({ t: 'host', auth: this.room.auth })))
    ws.on('message', (raw) => this.receive(ws, String(raw)))
    ws.on('pong', () => {
      this.awaitingPong = false
    })
    ws.on('close', (code) => {
      if (this.ws !== ws) return
      this.dropConnection()
      if (code === 4401)
        this.options.log.error('The relay says this room belongs to another host; will keep trying')
      this.schedule()
    })
    ws.on('error', (err) => this.options.log.debug(`relay: ${err.message}`))
  }

  private dropConnection() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    const ws = this.ws
    this.ws = null
    for (const device of [...this.devices.values()]) device.gone()
    this.devices.clear()
    if (ws && ws.readyState <= WebSocket.OPEN) ws.terminate()
    if (!this.stopped) this.status = 'offline'
  }

  private schedule() {
    if (this.stopped) return
    const { minMs, maxMs } = this.options.backoff ?? { minMs: 1000, maxMs: 30_000 }
    const delay = Math.min(maxMs, minMs * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  private out(ws: WebSocket, frame: object) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
  }

  private receive(ws: WebSocket, text: string) {
    if (this.ws !== ws || text === 'pong') return
    let frame: FromRelay
    try {
      frame = JSON.parse(text) as FromRelay
    } catch {
      return
    }
    if (frame.t === 'ready') {
      this.attempt = 0
      this.status = 'online'
      this.options.log.info('reachable through the relay')
      this.awaitingPong = false
      this.heartbeat = setInterval(
        () => {
          if (this.awaitingPong) return void ws.terminate()
          this.awaitingPong = true
          ws.ping()
        },
        this.options.heartbeatMs ?? 25_000,
      )
      return
    }
    if (frame.t === 'open') {
      const device = new DeviceSocket(
        (f) => this.out(ws, f),
        () => ws.bufferedAmount,
        frame.c,
        () => this.devices.delete(frame.c),
      )
      this.devices.get(frame.c)?.gone()
      this.devices.set(frame.c, device)
      return
    }
    const device = this.devices.get(frame.c)
    if (!device) return
    if (frame.t === 'close') return device.gone()
    try {
      if (frame.t === 'hi' && !device.channel) {
        const hostNonce = randomBytes(16)
        device.channel = new SecureChannel(this.key, fromBase64(frame.n), hostNonce, 'host')
        this.out(ws, { t: 'hi', c: frame.c, n: toBase64(hostNonce) })
        device.readyState = 1
        this.options.attach(device)
      } else if (frame.t === 'm' && device.channel) {
        const whole = device.pieces.push(frame.d, frame.f === true)
        if (whole !== null) device.emit('message', device.channel.open(whole))
      }
    } catch {
      // A message that does not decrypt: this is not a device that holds the key.
      device.close()
    }
  }
}
