import { DurableObject } from 'cloudflare:workers'
import {
  CLAIM_TIMEOUT_MS,
  CLOSE,
  hostAllowed,
  MAX_CLIENTS_PER_ROOM,
  newClientId,
  parseClientFrame,
  parseHostFrame,
  route,
  sameSecret,
} from '../src/protocol.ts'
import {
  MAX_BODY_BYTES,
  RETENTION_DAYS,
  summarize,
  validateBatch,
  type Batch,
} from '../src/metrics.ts'

/**
 * The BeddCode relay on Cloudflare: one Durable Object per room, where a host and the devices
 * paired with it meet. The object keeps no messages; it forwards each one and goes back to sleep
 * (WebSocket hibernation), so an idle room costs nothing. What passes through is end-to-end
 * encrypted by the endpoints, so this code can neither read nor change it.
 */
export interface Env {
  ROOMS: DurableObjectNamespace<Room>
  METRICS: DurableObjectNamespace<Metrics>
  /** Optional (`wrangler secret put RELAY_PASSWORD`): without it, only your own hosts can open rooms. */
  RELAY_PASSWORD?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return new Response('ok')
    if (url.pathname === '/metrics' || url.pathname === '/metrics/summary')
      return metricsRequest(request, url, env)
    const target = route(url.pathname)
    if (!target || request.headers.get('Upgrade') !== 'websocket')
      return new Response('Not found', { status: 404 })
    // Refused here, before any room exists, so strangers cost nothing.
    if (
      target.role === 'host' &&
      !hostAllowed(env.RELAY_PASSWORD, request.headers.get('Authorization'))
    )
      return new Response('Unauthorized', { status: 401 })
    return env.ROOMS.get(env.ROOMS.idFromName(target.room)).fetch(request)
  },
} satisfies ExportedHandler<Env>

/**
 * Speed measurements from your own apps. Only reachable with the relay password, and switched off
 * (503) while there is none, so nobody else can read or fill it.
 */
async function metricsRequest(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.RELAY_PASSWORD) return new Response('Set RELAY_PASSWORD to use metrics', { status: 503 })
  if (!hostAllowed(env.RELAY_PASSWORD, request.headers.get('Authorization')))
    return new Response('Unauthorized', { status: 401 })
  const store = env.METRICS.get(env.METRICS.idFromName('main'))
  if (url.pathname === '/metrics/summary' && request.method === 'GET') {
    const days = Math.min(RETENTION_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 7))
    return Response.json(await store.summary(days))
  }
  if (url.pathname === '/metrics' && request.method === 'POST') {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return new Response('Too large', { status: 413 })
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const batch = validateBatch(body)
    if (!batch) return new Response('Bad request', { status: 400 })
    const stored = await store.ingest(batch)
    return stored ? new Response(null, { status: 204 }) : new Response('Full', { status: 429 })
  }
  return new Response('Not found', { status: 404 })
}

interface HostState {
  claimed: boolean
  at: number
}

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private claimedHost(): WebSocket | undefined {
    return this.ctx
      .getWebSockets('host')
      .find((ws) => (ws.deserializeAttachment() as HostState | null)?.claimed)
  }

  override async fetch(request: Request): Promise<Response> {
    const target = route(new URL(request.url).pathname)
    if (!target) return new Response('Not found', { status: 404 })
    // A device with nobody to talk to is turned away before the upgrade, so it sees an ordinary
    // failure it can retry; a close right after accepting would race the handshake.
    if (target.role === 'client') {
      if (!this.claimedHost()) return new Response('host offline', { status: 503 })
      if (this.ctx.getWebSockets('client').length >= MAX_CLIENTS_PER_ROOM)
        return new Response('room full', { status: 429 })
    }
    const { 0: client, 1: server } = new WebSocketPair()

    if (target.role === 'host') {
      this.ctx.acceptWebSocket(server, ['host'])
      server.serializeAttachment({ claimed: false, at: Date.now() } satisfies HostState)
      // A host that never says who it is is dropped.
      await this.ctx.storage.setAlarm(Date.now() + CLAIM_TIMEOUT_MS)
    } else {
      const cid = newClientId()
      this.ctx.acceptWebSocket(server, ['client', `c:${cid}`])
      this.claimedHost()?.send(JSON.stringify({ t: 'open', c: cid }))
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  override async alarm(): Promise<void> {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets('host')) {
      const state = ws.deserializeAttachment() as HostState | null
      if (!state?.claimed && now - (state?.at ?? 0) >= CLAIM_TIMEOUT_MS)
        ws.close(CLOSE.unauthorized, 'claim')
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return ws.close(CLOSE.badRequest, 'text only')
    const tags = this.ctx.getTags(ws)
    if (tags.includes('host')) await this.fromHost(ws, message)
    else if (tags.includes('client')) this.fromClient(ws, tags, message)
  }

  private async fromHost(ws: WebSocket, text: string): Promise<void> {
    const frame = parseHostFrame(text)
    if (!frame) return ws.close(CLOSE.badRequest, 'bad frame')
    const state = ws.deserializeAttachment() as HostState | null
    if (!state?.claimed) {
      if (frame.t !== 'host') return ws.close(CLOSE.badRequest, 'claim first')
      const known = await this.ctx.storage.get<string>('auth')
      if (known !== undefined && !sameSecret(known, frame.auth))
        return ws.close(CLOSE.unauthorized, 'room belongs to another host')
      if (known === undefined) await this.ctx.storage.put('auth', frame.auth)
      // A host that reconnects replaces its own stale connection.
      for (const other of this.ctx.getWebSockets('host'))
        if (other !== ws && (other.deserializeAttachment() as HostState | null)?.claimed)
          other.close(CLOSE.replaced, 'replaced')
      ws.serializeAttachment({ claimed: true, at: Date.now() } satisfies HostState)
      return ws.send(JSON.stringify({ t: 'ready' }))
    }
    if (frame.t === 'host') return
    const device = this.ctx.getWebSockets(`c:${frame.c}`)[0]
    if (!device) return
    if (frame.t === 'close') return device.close(1000, 'closed by host')
    device.send(
      JSON.stringify(
        frame.t === 'hi' ? { t: 'hi', n: frame.n } : { t: 'm', d: frame.d, f: frame.f },
      ),
    )
  }

  private fromClient(ws: WebSocket, tags: string[], text: string): void {
    const frame = parseClientFrame(text)
    if (!frame) return ws.close(CLOSE.badRequest, 'bad frame')
    const cid = tags.find((t) => t.startsWith('c:'))?.slice(2)
    const host = this.claimedHost()
    if (!cid || !host) return ws.close(CLOSE.hostOffline, 'host offline')
    host.send(JSON.stringify({ ...frame, c: cid }))
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Reserved codes (1005, 1006) cannot be sent back; the socket may also already be closed.
    try {
      ws.close(code >= 1000 && code < 1004 ? code : 1000, reason.slice(0, 100))
    } catch {
      // Already closed.
    }
    const tags = this.ctx.getTags(ws)
    if (tags.includes('host')) {
      // Without its host a room has nothing to offer: devices reconnect when it is back.
      const stillThere = this.ctx
        .getWebSockets('host')
        .some((h) => h !== ws && (h.deserializeAttachment() as HostState | null)?.claimed)
      if (!stillThere)
        for (const device of this.ctx.getWebSockets('client'))
          device.close(CLOSE.hostOffline, 'host offline')
    } else if (tags.includes('client')) {
      const cid = tags.find((t) => t.startsWith('c:'))?.slice(2)
      this.claimedHost()?.send(JSON.stringify({ t: 'close', c: cid }))
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error')
  }
}

const MAX_SAMPLES = 300_000

/** Where the measurements live: one small SQLite database inside a Durable Object. */
export class Metrics extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS samples (
         t INTEGER NOT NULL, host TEXT NOT NULL, platform TEXT NOT NULL,
         name TEXT NOT NULL, value REAL NOT NULL, route TEXT, tags TEXT)`,
    )
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS samples_t ON samples (t)')
  }

  /** False when the store is full, so a runaway client cannot fill it. */
  async ingest(batch: Batch): Promise<boolean> {
    const sql = this.ctx.storage.sql
    const count = sql.exec('SELECT COUNT(*) AS n FROM samples').one().n as number
    if (count + batch.records.length > MAX_SAMPLES) return false
    this.ctx.storage.transactionSync(() => {
      for (const r of batch.records)
        sql.exec(
          'INSERT INTO samples (t, host, platform, name, value, route, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
          r.t,
          batch.host,
          batch.platform,
          r.name,
          r.value,
          r.tags?.route ?? null,
          r.tags ? JSON.stringify(r.tags) : null,
        )
    })
    // Old samples are dropped once a day.
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 24 * 3600_000)
    return true
  }

  async summary(days: number) {
    const since = Date.now() - days * 24 * 3600_000
    const rows = this.ctx.storage.sql
      .exec('SELECT name, platform, route, value FROM samples WHERE t >= ?', since)
      .toArray() as { name: string; platform: string; route: string | null; value: number }[]
    return { days, samples: rows.length, rows: summarize(rows) }
  }

  override async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(
      'DELETE FROM samples WHERE t < ?',
      Date.now() - RETENTION_DAYS * 24 * 3600_000,
    )
    await this.ctx.storage.setAlarm(Date.now() + 24 * 3600_000)
  }
}
