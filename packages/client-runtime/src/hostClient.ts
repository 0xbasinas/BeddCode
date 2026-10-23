import {
  PROTOCOL_VERSION,
  type ClientFrame,
  ServerFrame,
  type HostInfo,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
  type StoredEvent,
} from '@beddcode/contracts'

/** `denied`: the host refused our token. It will not help to retry; the device has to be paired again. */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'denied'

export interface HostClientOptions {
  /** One address, or several routes to the same host (tried in order, e.g. tailnet name then IP). */
  url: string | string[]
  token?: string
  /** Refuse routes that now point at a different machine. */
  expectedHostId?: string
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  heartbeatMs?: number
  /** After `reconnectNow`, how long a connection that looks open has to answer a ping. */
  probeTimeoutMs?: number
  /** Resume point, e.g. restored from a persisted replica. */
  initialSeq?: number
  onEvent(stored: StoredEvent): void
  onCaughtUp?(seq: number): void
  /** Terminal output and file-change notifications: live data that is not part of the event log. */
  onFrame?(frame: Extract<ServerFrame, { t: 'term.out' | 'term.exit' | 'fs.changed' }>): void
  onState?(state: ConnectionState, host?: HostInfo): void
  /** Inject a socket for tests; defaults to the platform WebSocket. */
  createSocket?(url: string): WebSocket
  backoff?: { minMs: number; maxMs: number }
}

interface Pending {
  resolve(value: unknown): void
  reject(reason: Error): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * One connection to one host. Reconnects with backoff and resubscribes after the last event it
 * has seen, so the caller observes a gapless, duplicate-free stream across network drops.
 */
export class HostClient {
  private ws: WebSocket | null = null
  private state: ConnectionState = 'connecting'
  private lastSeq: number
  private attempt = 0
  private route = 0
  private nextId = 1
  private timer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private awaitingPong = false
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  /** Drops the current socket and moves on, as when it times out. */
  private abandonSocket: (() => void) | null = null
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly options: HostClientOptions) {
    this.lastSeq = options.initialSeq ?? 0
  }

  private get routes(): string[] {
    const { url } = this.options
    return Array.isArray(url) ? url : [url]
  }

  /** The address currently in use (or being tried). */
  get activeUrl(): string {
    return this.routes[this.route % this.routes.length]!
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  get seq(): number {
    return this.lastSeq
  }

  start() {
    if (this.ws || this.timer || this.state === 'denied') return
    this.setState('connecting')
    this.open()
  }

  stop() {
    this.setState('stopped')
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.clearSocketTimers()
    this.ws?.close()
    this.ws = null
    this.failPending(new Error('client stopped'))
  }

  /**
   * The device just woke, came back online or to the foreground: a connection that looks open may
   * be dead, and a reconnect may be sitting out a long back-off. Check the first at once, and skip
   * the wait for the second.
   */
  reconnectNow() {
    if (this.state === 'stopped' || this.state === 'denied') return
    if (this.state === 'connected' && this.ws) {
      if (this.probeTimer) return
      this.awaitingPong = true
      this.ws.send(JSON.stringify({ t: 'ping' }))
      this.probeTimer = setTimeout(() => {
        this.probeTimer = null
        if (this.awaitingPong) this.abandonSocket?.()
      }, this.options.probeTimeoutMs ?? 3_000)
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.attempt = 0
      this.open()
    } else if (!this.ws) {
      this.attempt = 0
      this.open()
    }
    // Otherwise a connection attempt is already under way.
  }

  request<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const ws = this.ws
    if (!ws || ws.readyState !== 1 || this.state !== 'connected') {
      return Promise.reject(new Error('not connected'))
    }
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            'The host took too long to answer. The operation may still be running; check it before retrying.',
          ),
        )
      }, this.options.requestTimeoutMs ?? 180_000)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ t: 'req', id, method, params }))
    })
  }

  /** Sends a frame if connected. Returns false when it could not be sent (the caller may retry). */
  send(frame: ClientFrame): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== 1 || this.state !== 'connected') return false
    ws.send(JSON.stringify(frame))
    return true
  }

  private open() {
    const create = this.options.createSocket ?? ((url: string) => new WebSocket(url))
    const ws = create(this.activeUrl)
    this.ws = ws
    let welcomed = false
    const disconnected = () => {
      if (this.ws !== ws) return
      this.clearSocketTimers()
      this.ws = null
      this.abandonSocket = null
      this.failPending(new Error('connection lost'))
      if (!welcomed) this.route = (this.route + 1) % this.routes.length
      if (this.state !== 'stopped' && this.state !== 'denied') this.scheduleReconnect()
    }
    // Closing a socket that is still connecting can itself take a long time in browsers.
    // Detach immediately so another route can be tried without waiting for its close event.
    const abandon = () => {
      disconnected()
      ws.close()
    }
    this.abandonSocket = abandon
    this.connectTimer = setTimeout(abandon, this.options.connectTimeoutMs ?? 5_000)

    ws.onopen = () => {
      if (this.ws !== ws) return
      ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, token: this.options.token }))
    }
    ws.onmessage = (msg) => {
      if (this.ws !== ws) return
      let frame: ServerFrame
      try {
        frame = ServerFrame.parse(JSON.parse(String(msg.data)))
      } catch {
        return
      }
      if (frame.t === 'welcome') {
        if (welcomed) return
        if (
          frame.protocol !== PROTOCOL_VERSION ||
          (this.options.expectedHostId && frame.host.hostId !== this.options.expectedHostId)
        ) {
          abandon()
          return
        }
        welcomed = true
        if (this.connectTimer) clearTimeout(this.connectTimer)
        this.connectTimer = null
        this.awaitingPong = false
        this.heartbeat = setInterval(() => {
          if (this.awaitingPong) {
            abandon()
            return
          }
          this.awaitingPong = true
          ws.send(JSON.stringify({ t: 'ping' }))
        }, this.options.heartbeatMs ?? 15_000)
      } else if (!welcomed && frame.t !== 'denied') return
      this.handle(ws, frame)
    }
    ws.onclose = disconnected
    ws.onerror = () => {
      // `close` follows; reconnect is handled there.
    }
  }

  private handle(ws: WebSocket, frame: ServerFrame) {
    switch (frame.t) {
      case 'welcome':
        this.attempt = 0
        this.setState('connected', frame.host)
        ws.send(JSON.stringify({ t: 'subscribe', afterSeq: this.lastSeq }))
        break
      case 'denied':
        this.setState('denied')
        ws.close()
        break
      case 'pong':
        this.awaitingPong = false
        if (this.probeTimer) clearTimeout(this.probeTimer)
        this.probeTimer = null
        break
      case 'event':
        if (frame.stored.seq > this.lastSeq) {
          this.lastSeq = frame.stored.seq
          this.options.onEvent(frame.stored)
        }
        break
      case 'caught-up':
        this.options.onCaughtUp?.(frame.seq)
        break
      case 'term.out':
      case 'term.exit':
      case 'fs.changed':
        this.options.onFrame?.(frame)
        break
      case 'res': {
        const p = this.pending.get(frame.id)
        if (!p) break
        this.pending.delete(frame.id)
        clearTimeout(p.timer)
        if (frame.ok) p.resolve(frame.result)
        else p.reject(new Error(frame.error ?? 'request failed'))
        break
      }
    }
  }

  private scheduleReconnect() {
    const { minMs, maxMs } = this.options.backoff ?? { minMs: 250, maxMs: 10_000 }
    this.setState('reconnecting')
    // Going through every route once counts as one step of backoff, so alternatives are tried quickly.
    const delay =
      Math.min(maxMs, minMs * 2 ** Math.floor(this.attempt / this.routes.length)) *
      (0.75 + Math.random() * 0.5)
    this.attempt++
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.state !== 'stopped') this.open()
    }, delay)
  }

  private failPending(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
  }

  private clearSocketTimers() {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.connectTimer = null
    this.heartbeat = null
    this.probeTimer = null
  }

  private setState(state: ConnectionState, host?: HostInfo) {
    this.state = state
    this.options.onState?.(state, host)
  }
}
