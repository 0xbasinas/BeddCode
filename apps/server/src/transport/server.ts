import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  ClientFrame,
  PROTOCOL_VERSION,
  type HostInfo,
  type PairResult,
  type ServerFrame,
} from '@beddcode/contracts'
import type { Logger } from '@beddcode/shared'
import {
  classifyPeer,
  defaultGuard,
  needsToken,
  originAllowed,
  peerAllowed,
  type GuardOptions,
  type PeerClass,
} from '../auth/guard.ts'
import type { PairingManager } from '../auth/pairing.ts'
import type { TokenStore } from '../auth/tokens.ts'
import type { TailscaleService } from '../network/tailscale.ts'
import type { EventStore } from '../store/eventStore.ts'
import type { AgentCatalog } from '../agents/catalog.ts'
import type { AttachmentStore } from '../attachments/store.ts'
import type { SessionManager } from '../sessions/sessionManager.ts'
import type { FileWatchers } from '../files/watcher.ts'
import { createRpcRouter, type RpcContext, type WorkspaceServices } from './rpc.ts'

function parsePairRequest(body: unknown): { code: string; deviceName: string } | null {
  if (typeof body !== 'object' || body === null) return null
  const { code, deviceName } = body as Record<string, unknown>
  if (typeof code !== 'string') return null
  return { code, deviceName: typeof deviceName === 'string' ? deviceName : '' }
}

const reply = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Reads a small JSON request body; anything large or not JSON is rejected. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!req.headers['content-type']?.startsWith('application/json')) {
      return reject(new Error('content-type'))
    }
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 4096) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

export interface StartServerOptions {
  port: number
  host: string
  hostId: string
  hostName?: string
  defaultCwd?: string
  store: EventStore
  sessions: SessionManager
  agents: AgentCatalog
  attachments: AttachmentStore
  workspace: WorkspaceServices
  watchers: FileWatchers
  tokens: TokenStore
  pairing: PairingManager
  tailscale: TailscaleService
  /** Who may connect; defaults to this machine plus the tailnet, tokens for everyone else. */
  guard?: GuardOptions
  log: Logger
}

export interface RunningServer {
  port: number
  hostInfo: HostInfo
  close(): Promise<void>
}

const VERSION = '0.0.0'
const REPLAY_BATCH = 1000

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { store, log } = options
  const hostInfo: HostInfo = {
    hostId: options.hostId,
    name: options.hostName ?? os.hostname(),
    platform:
      process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux',
    version: VERSION,
    defaultCwd: options.defaultCwd,
  }
  const guard = options.guard ?? defaultGuard()
  let listeningPort = options.port
  const dispatch = createRpcRouter(
    options.sessions,
    options.agents,
    options.attachments,
    options.workspace,
    {
      tokens: options.tokens,
      pairing: options.pairing,
      tailscale: options.tailscale,
      port: () => listeningPort,
    },
  )

  const http = createServer((req, res) => {
    const peer = classifyPeer(req.socket.remoteAddress)
    const origin = req.headers.origin
    const url = (req.url ?? '').split('?')[0]

    if (!peerAllowed(peer, guard)) {
      res.writeHead(403).end()
      return
    }
    // Answers to pages we allow; other origins get no CORS headers and so cannot read anything.
    if (origin && originAllowed(origin, guard)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-allow-headers', 'content-type')
      res.setHeader('vary', 'origin')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, host: hostInfo }))
      return
    }

    if (url === '/pair' && req.method === 'POST') {
      if (!originAllowed(origin, guard)) return void res.writeHead(403).end()
      void readJson(req)
        .then((body) => {
          const parsed = parsePairRequest(body)
          if (!parsed) return reply(res, 400, { error: 'Send {code, deviceName}' })
          const outcome = options.pairing.redeem(parsed.code)
          if (outcome === 'locked') {
            return reply(res, 429, {
              error: 'Too many wrong codes. Wait a minute and ask for a new one.',
            })
          }
          if (outcome === 'invalid')
            return reply(res, 403, { error: 'That code is wrong or has expired' })
          const { token, device } = options.tokens.issue(parsed.deviceName)
          log.info(`paired device "${device.name}" from ${req.socket.remoteAddress}`)
          reply(res, 200, { token, host: hostInfo } satisfies PairResult)
        })
        .catch(() => reply(res, 400, { error: 'Invalid request' }))
      return
    }

    // For the CLI on this machine: `beddcode-server pair` asks for a code here.
    if (url === '/admin/pair' && req.method === 'POST') {
      if (peer !== 'loopback' || origin !== undefined) return void res.writeHead(403).end()
      reply(res, 200, options.pairing.create())
      return
    }
    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    // Refuse before the upgrade completes: wrong network, or a web page that is not ours.
    verifyClient: ({ req }, done) => {
      const peer = classifyPeer(req.socket.remoteAddress)
      if (!peerAllowed(peer, guard)) return done(false, 403, 'network')
      if (!originAllowed(req.headers.origin, guard)) return done(false, 403, 'origin')
      done(true)
    },
  })
  wss.on('connection', (ws, req) => handleConnection(ws, classifyPeer(req.socket.remoteAddress)))

  function handleConnection(ws: WebSocket, peer: PeerClass) {
    // Trusted peers (this machine) are in at once; everyone else proves a token in `hello`.
    let authed = !needsToken(peer, guard)
    let deviceId: string | undefined
    const context: RpcContext = { peer }
    const send = (frame: ServerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }
    const stopOnRevoke = options.tokens.onRevoke((id) => {
      if (id !== deviceId) return
      authed = false
      send({ t: 'denied', reason: 'auth' })
      ws.close(1008, 'device revoked')
    })
    let unsubscribe: (() => void) | null = null
    // What this connection is attached to, released when it goes away.
    const terminalDetach = new Map<string, () => void>()
    const watching = new Map<string, () => void>()
    const terminalClient = {
      send: (frame: ServerFrame) => send(frame),
      backlog: () => ws.bufferedAmount,
    }
    ws.on('close', () => {
      stopOnRevoke()
      unsubscribe?.()
      terminalDetach.forEach((detach) => detach())
      watching.forEach((release) => release())
    })

    ws.on('message', (raw) => {
      let frame: ClientFrame
      try {
        frame = ClientFrame.parse(JSON.parse(String(raw)))
      } catch {
        ws.close(1003, 'invalid frame')
        return
      }

      if (!authed) {
        const device = frame.t === 'hello' ? options.tokens.verify(frame.token) : null
        if (device) {
          authed = true
          deviceId = device.id
        } else {
          send({ t: 'denied', reason: 'auth' })
          ws.close(1008, 'auth')
          return
        }
      }

      switch (frame.t) {
        case 'ping':
          send({ t: 'pong' })
          break
        case 'hello':
          if (frame.protocol !== PROTOCOL_VERSION) {
            ws.close(1002, 'protocol version')
            return
          }
          send({ t: 'welcome', protocol: PROTOCOL_VERSION, host: hostInfo })
          break
        case 'req':
          dispatch(frame.method, frame.params, context).then(
            (result) => send({ t: 'res', id: frame.id, ok: true, result }),
            (err: unknown) =>
              send({
                t: 'res',
                id: frame.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              }),
          )
          break
        case 'term.attach':
          terminalDetach.get(frame.id)?.()
          try {
            terminalDetach.set(
              frame.id,
              options.workspace.terminals.attach(frame.id, terminalClient),
            )
          } catch {
            // The terminal was closed meanwhile; tell the client so it stops waiting.
            send({ t: 'term.exit', id: frame.id, code: null })
          }
          break
        case 'term.detach':
          terminalDetach.get(frame.id)?.()
          terminalDetach.delete(frame.id)
          break
        case 'term.input':
          options.workspace.terminals.write(frame.id, frame.data)
          break
        case 'term.resize':
          options.workspace.terminals.resize(frame.id, frame.cols, frame.rows)
          break
        case 'fs.watch':
          if (!watching.has(frame.cwd)) {
            watching.set(
              frame.cwd,
              options.watchers.acquire(frame.cwd, (paths) =>
                send({ t: 'fs.changed', cwd: frame.cwd, paths }),
              ),
            )
          }
          break
        case 'fs.unwatch':
          watching.get(frame.cwd)?.()
          watching.delete(frame.cwd)
          break
        case 'subscribe': {
          unsubscribe?.()
          // Replay and attach the live listener in one synchronous step: appends are synchronous,
          // so no event can slip between the last replayed row and the first live one.
          let cursor = frame.afterSeq
          for (;;) {
            const batch = store.readAfter(cursor, REPLAY_BATCH)
            for (const stored of batch) send({ t: 'event', stored })
            if (batch.length < REPLAY_BATCH) {
              cursor = batch.at(-1)?.seq ?? cursor
              break
            }
            cursor = batch.at(-1)!.seq
          }
          send({ t: 'caught-up', seq: cursor })
          unsubscribe = store.subscribe((stored) => send({ t: 'event', stored }))
          break
        }
      }
    })
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port, options.host, resolve)
  })
  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  listeningPort = port
  log.debug(`http listening on ${options.host}:${port}`)

  return {
    port,
    hostInfo,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => http.close(() => resolve()))
      }),
  }
}
