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

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

export interface HostClientOptions {
  url: string
  token?: string
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
  private nextId = 1
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly options: HostClientOptions) {
    this.lastSeq = options.initialSeq ?? 0
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  get seq(): number {
    return this.lastSeq
  }

  start() {
    if (this.state === 'stopped') this.state = 'connecting'
    this.open()
  }

  stop() {
    this.setState('stopped')
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.ws?.close()
    this.ws = null
    this.failPending(new Error('client stopped'))
  }

  request<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const ws = this.ws
    if (!ws || ws.readyState !== 1 || this.state !== 'connected') {
      return Promise.reject(new Error('not connected'))
    }
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
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
    const ws = create(this.options.url)
    this.ws = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, token: this.options.token }))
    }
    ws.onmessage = (msg) => {
      let frame: ServerFrame
      try {
        frame = ServerFrame.parse(JSON.parse(String(msg.data)))
      } catch {
        return
      }
      this.handle(ws, frame)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.failPending(new Error('connection lost'))
      if (this.state !== 'stopped') this.scheduleReconnect()
    }
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
        if (frame.ok) p.resolve(frame.result)
        else p.reject(new Error(frame.error ?? 'request failed'))
        break
      }
    }
  }

  private scheduleReconnect() {
    const { minMs, maxMs } = this.options.backoff ?? { minMs: 250, maxMs: 10_000 }
    this.setState('reconnecting')
    const delay = Math.min(maxMs, minMs * 2 ** this.attempt) * (0.75 + Math.random() * 0.5)
    this.attempt++
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.state !== 'stopped') this.open()
    }, delay)
  }

  private failPending(error: Error) {
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }

  private setState(state: ConnectionState, host?: HostInfo) {
    this.state = state
    this.options.onState?.(state, host)
  }
}
