import {
  PROTOCOL_VERSION,
  type BrowserUseCall,
  type ClientFrame,
  ServerFrame,
  type HostInfo,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
  type StoredEvent,
} from '@beddcode/contracts'
import { Recorder, now } from './perf.ts'
import { RelaySocket, isRelayRoute } from './relaySocket.ts'

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
  /** The host log that `initialSeq` belongs to. A host with another log gets a full replay. */
  resumeLogId?: string
  /** The host's log is not the one this client was following: forget what was built from it. */
  onReset?(): void
  onEvent(stored: StoredEvent): void
  onCaughtUp?(seq: number): void
  /** Terminal output and file-change notifications: live data that is not part of the event log. */
  onFrame?(
    frame: Extract<ServerFrame, { t: 'term.out' | 'term.exit' | 'fs.changed' | 'design.changed' }>,
  ): void
  onState?(state: ConnectionState, host?: HostInfo): void
  /** An agent's browser tool call to run (only after `offerBrowser` said this client can). */
  onBrowserCall?(id: string, call: BrowserUseCall): void
  /** An agent wants a picture of a design (only after `offerDesign` said this client can). */
  onDesignRender?(request: Extract<ServerFrame, { t: 'design.render' }>): void
  /** An agent wants SVG markup turned into design elements (same condition). */
  onDesignImport?(request: Extract<ServerFrame, { t: 'design.import' }>): void
  /** An agent's edit needs auto layout and text sizes worked out (same condition). */
  onDesignLayout?(request: Extract<ServerFrame, { t: 'design.layout' }>): void
  /** How long a message waits for the connection to come back before it fails. Default 30 s. */
  queueWaitMs?: number
  /** Inject a socket for tests; defaults to the platform WebSocket. */
  createSocket?(url: string): WebSocket
  backoff?: { minMs: number; maxMs: number }
}

/** Requests that change something and would otherwise be lost, or doubled, by a dropped connection. */
const RELIABLE_METHODS: ReadonlySet<string> = new Set([
  'sessions.create',
  'sessions.prompt',
  'sessions.approve',
  'sessions.answer',
  'sessions.dequeue',
])

class ConnectionLost extends Error {
  constructor() {
    super('connection lost')
  }
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
  /** The log being followed; learned at the first welcome, or given by a restored copy. */
  private logId: string | undefined
  /** True until the first replay ends, when the history held at the start came from disk. */
  private restored: boolean
  /** Measurements of this connection (connect and replay times), see perf.ts. */
  readonly perf = new Recorder()
  private connectStartedAt = 0
  private replay: { start: number; events: number; bytes: number; resume: string } | null = null
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
  /** Reliable requests waiting for a connection; woken when one is up (or the client stops). */
  private readonly waiting = new Set<() => void>()

  constructor(private readonly options: HostClientOptions) {
    this.lastSeq = options.initialSeq ?? 0
    this.logId = options.resumeLogId
    this.restored = this.lastSeq > 0
  }

  /** Continues from a saved copy of the history. Only before `start`. */
  restore(seq: number, logId: string) {
    if (this.ws || this.lastSeq > 0) return
    this.lastSeq = seq
    this.logId = logId
    this.restored = seq > 0
  }

  /** Which host log this follows (undefined until connected, or for an older host). */
  get log(): string | undefined {
    return this.logId
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
    for (const wake of [...this.waiting]) wake()
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
    if (RELIABLE_METHODS.has(method)) return this.reliable(method, params)
    return this.send1(method, params)
  }

  /**
   * Sends a request that must not be lost: while the connection is down it waits for it, and a
   * connection that drops mid-request sends it again with the same `rid`, which the host answers
   * from its first run instead of doing the work twice.
   */
  private reliable<M extends RpcMethodName>(
    method: M,
    params: RpcParams<M>,
  ): Promise<RpcResult<M>> {
    const rid = Math.random().toString(36).slice(2) + Date.now().toString(36)
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 180_000)
    const waitMs = this.options.queueWaitMs ?? 30_000
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (this.state === 'stopped' || this.state === 'denied')
          return reject(new Error('not connected'))
        if (Date.now() >= deadline) return reject(new Error('The host took too long to answer.'))
        if (this.state !== 'connected' || !this.ws || this.ws.readyState !== 1) {
          const wake = () => {
            clearTimeout(giveUp)
            this.waiting.delete(wake)
            attempt()
          }
          const giveUp = setTimeout(
            () => {
              this.waiting.delete(wake)
              reject(new Error('not connected'))
            },
            Math.min(waitMs, deadline - Date.now()),
          )
          this.waiting.add(wake)
          return
        }
        this.send1(method, params, rid).then(
          (result) => resolve(result),
          (err: unknown) => (err instanceof ConnectionLost ? attempt() : reject(err)),
        )
      }
      attempt()
    })
  }

  private send1<M extends RpcMethodName>(
    method: M,
    params: RpcParams<M>,
    rid?: string,
  ): Promise<RpcResult<M>> {
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
      ws.send(JSON.stringify({ t: 'req', id, method, params, rid }))
    })
  }

  private browserOffer: Extract<ClientFrame, { t: 'browser.offer' }> | null = null

  /**
   * Tells the host whether this client runs agents' browser tools and which session it shows.
   * Remembered and sent again on every reconnect.
   */
  offerBrowser(offer: Omit<Extract<ClientFrame, { t: 'browser.offer' }>, 't'>) {
    const frame = { t: 'browser.offer' as const, ...offer }
    if (JSON.stringify(frame) === JSON.stringify(this.browserOffer)) return
    this.browserOffer = frame
    this.send(frame)
  }

  private designView: Extract<ClientFrame, { t: 'design.view' }> | null = null

  /**
   * Tells the host whether this client can draw designs for agents and what it has open in the
   * Design screen. Remembered and sent again on every reconnect.
   */
  offerDesign(view: Omit<Extract<ClientFrame, { t: 'design.view' }>, 't'>) {
    const frame = { t: 'design.view' as const, ...view }
    if (JSON.stringify(frame) === JSON.stringify(this.designView)) return
    this.designView = frame
    this.send(frame)
  }

  /** Sends a frame if connected. Returns false when it could not be sent (the caller may retry). */
  send(frame: ClientFrame): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== 1 || this.state !== 'connected') return false
    ws.send(JSON.stringify(frame))
    return true
  }

  private open() {
    const create =
      this.options.createSocket ??
      ((url: string) =>
        (isRelayRoute(url) ? new RelaySocket(url) : new WebSocket(url)) as unknown as WebSocket)
    const ws = create(this.activeUrl)
    this.ws = ws
    this.connectStartedAt = now()
    let welcomed = false
    const disconnected = () => {
      if (this.ws !== ws) return
      this.clearSocketTimers()
      this.ws = null
      this.abandonSocket = null
      this.failPending(new ConnectionLost())
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
      if (this.replay && typeof msg.data === 'string') this.replay.bytes += msg.data.length
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
        // A host whose database was replaced has a different log; what we hold is not part of it.
        if (this.logId !== undefined && frame.host.logId !== this.logId) {
          this.lastSeq = 0
          this.restored = false
          this.options.onReset?.()
        }
        this.logId = frame.host.logId
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
        {
          const route = isRelayRoute(this.activeUrl) ? 'relay' : 'direct'
          this.perf.record('connect.ms', now() - this.connectStartedAt, { route })
          this.replay = {
            start: now(),
            events: 0,
            bytes: 0,
            resume: this.lastSeq === 0 ? 'cold' : this.restored ? 'disk' : 'warm',
          }
        }
        ws.send(JSON.stringify({ t: 'subscribe', afterSeq: this.lastSeq, compact: true }))
        if (this.browserOffer) ws.send(JSON.stringify(this.browserOffer))
        if (this.designView) ws.send(JSON.stringify(this.designView))
        for (const wake of [...this.waiting]) wake()
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
        if (this.replay) this.replay.events++
        if (frame.stored.seq > this.lastSeq) {
          this.lastSeq = frame.stored.seq
          this.options.onEvent(frame.stored)
        }
        break
      case 'caught-up':
        if (this.replay) {
          const { start, events, bytes, resume } = this.replay
          const tags = { route: isRelayRoute(this.activeUrl) ? 'relay' : 'direct', resume }
          this.perf.record('replay.ms', now() - start, tags)
          this.perf.record('replay.events', events, tags)
          this.perf.record('replay.kb', bytes / 1024, tags)
          this.replay = null
        }
        this.restored = false
        // The replay may have joined its last events into earlier ones; this is where it really ended.
        if (frame.seq > this.lastSeq) this.lastSeq = frame.seq
        this.options.onCaughtUp?.(frame.seq)
        break
      case 'term.out':
      case 'term.exit':
      case 'fs.changed':
      case 'design.changed':
        this.options.onFrame?.(frame)
        break
      case 'browser.call':
        this.options.onBrowserCall?.(frame.id, frame.call)
        break
      case 'design.render':
        this.options.onDesignRender?.(frame)
        break
      case 'design.import':
        this.options.onDesignImport?.(frame)
        break
      case 'design.layout':
        this.options.onDesignLayout?.(frame)
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
