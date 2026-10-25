import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  CLAIM_TIMEOUT_MS,
  CLOSE,
  MAX_CLIENTS_PER_ROOM,
  MAX_FRAME_CHARS,
  newClientId,
  parseClientFrame,
  parseHostFrame,
  route,
  sameSecret,
} from './protocol.ts'

export interface RelayOptions {
  port: number
  host?: string
  log?: (message: string) => void
  /** Rooms nobody has used for this long are forgotten, and can be claimed again. Default 30 days. */
  roomTtlMs?: number
}

export interface RunningRelay {
  port: number
  close(): Promise<void>
}

interface Room {
  /** Proof of ownership, set by the first host to connect. */
  auth: string
  host?: WebSocket
  clients: Map<string, WebSocket>
  lastUsed: number
}

const PING_MS = 30_000

/**
 * A relay for self-hosting and tests, with the same behaviour as the Cloudflare one: hosts and
 * devices meet in a room, and encrypted messages are passed between them untouched.
 */
export async function startRelay(options: RelayOptions): Promise<RunningRelay> {
  const log = options.log ?? (() => {})
  const rooms = new Map<string, Room>()
  const ttl = options.roomTtlMs ?? 30 * 24 * 3600_000

  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
      return
    }
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_CHARS * 2 })
  http.on('upgrade', (req, socket, head) => {
    const target = route((req.url ?? '').split('?')[0]!)
    if (!target) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      target.role === 'host' ? onHost(ws, target.room) : onClient(ws, target.room),
    )
  })

  const send = (ws: WebSocket | undefined, frame: unknown) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }

  function onHost(ws: WebSocket, roomId: string) {
    let room: Room | undefined
    const timer = setTimeout(() => ws.close(CLOSE.unauthorized, 'claim'), CLAIM_TIMEOUT_MS)
    ws.on('message', (raw) => {
      const text = String(raw)
      if (text === 'ping') return void ws.send('pong')
      const frame = parseHostFrame(text)
      if (!frame) return void ws.close(CLOSE.badRequest, 'bad frame')
      if (!room) {
        if (frame.t !== 'host') return void ws.close(CLOSE.badRequest, 'claim first')
        clearTimeout(timer)
        const known = rooms.get(roomId)
        if (known && !sameSecret(known.auth, frame.auth))
          return void ws.close(CLOSE.unauthorized, 'room belongs to another host')
        room = known ?? { auth: frame.auth, clients: new Map(), lastUsed: Date.now() }
        rooms.set(roomId, room)
        // A host that reconnects replaces its own stale connection.
        if (room.host && room.host !== ws) room.host.close(CLOSE.replaced, 'replaced')
        room.host = ws
        room.lastUsed = Date.now()
        log(`host online in room ${roomId.slice(0, 6)}…`)
        return send(ws, { t: 'ready' })
      }
      room.lastUsed = Date.now()
      if (frame.t === 'host') return
      const client = room.clients.get(frame.c)
      if (frame.t === 'close') return void client?.close(1000, 'closed by host')
      send(client, frame.t === 'hi' ? { t: 'hi', n: frame.n } : { t: 'm', d: frame.d, f: frame.f })
    })
    ws.on('close', () => {
      clearTimeout(timer)
      if (room?.host === ws) {
        room.host = undefined
        for (const client of room.clients.values()) client.close(CLOSE.hostOffline, 'host offline')
        room.clients.clear()
      }
    })
  }

  function onClient(ws: WebSocket, roomId: string) {
    const room = rooms.get(roomId)
    if (!room?.host) return void ws.close(CLOSE.hostOffline, 'host offline')
    if (room.clients.size >= MAX_CLIENTS_PER_ROOM) return void ws.close(CLOSE.roomFull, 'room full')
    const cid = newClientId()
    room.clients.set(cid, ws)
    send(room.host, { t: 'open', c: cid })
    ws.on('message', (raw) => {
      const text = String(raw)
      if (text === 'ping') return void ws.send('pong')
      const frame = parseClientFrame(text)
      if (!frame) return void ws.close(CLOSE.badRequest, 'bad frame')
      room.lastUsed = Date.now()
      send(room.host, { ...frame, c: cid })
    })
    ws.on('close', () => {
      if (room.clients.get(cid) === ws) {
        room.clients.delete(cid)
        send(room.host, { t: 'close', c: cid })
      }
    })
  }

  // A silent socket (a phone that lost signal) is closed so its room does not fill up.
  const alive = new WeakSet<WebSocket>()
  wss.on('connection', (ws) => {
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))
  })
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) ws.terminate()
      else {
        alive.delete(ws)
        ws.ping()
      }
    }
    const now = Date.now()
    for (const [id, room] of rooms)
      if (!room.host && now - room.lastUsed > ttl) rooms.delete(id)
  }, PING_MS)
  sweep.unref()

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port, options.host ?? '0.0.0.0', resolve)
  })
  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  log(`relay listening on ${options.host ?? '0.0.0.0'}:${port}`)

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep)
        for (const ws of wss.clients) ws.terminate()
        wss.close(() => http.close(() => resolve()))
      }),
  }
}
