import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import { WebSocketServer, type ServerOptions, type WebSocket } from 'ws'
import {
  ClientFrame,
  PROTOCOL_VERSION,
  type HostInfo,
  type PairResult,
  type ServerFrame,
} from '@beddcode/contracts'
import type { Logger } from '@beddcode/shared'
import {
  classifyRequest,
  defaultGuard,
  needsToken,
  originAllowed,
  peerAllowed,
  type GuardOptions,
  type PeerClass,
} from '../auth/guard.ts'
import type { PairingManager } from '../auth/pairing.ts'
import type { TokenStore } from '../auth/tokens.ts'
import type { AgentTools } from '../automation/agentTools.ts'
import type { BrowserBroker } from '../automation/browserUse.ts'
import type { DesignLink } from '../design/designLink.ts'
import type { TailscaleService } from '../network/tailscale.ts'
import type { EventStore } from '../store/eventStore.ts'
import type { AgentCatalog } from '../agents/catalog.ts'
import type { AttachmentStore } from '../attachments/store.ts'
import type { SessionManager } from '../sessions/sessionManager.ts'
import type { FileWatchers } from '../files/watcher.ts'
import { serveMedia } from '../files/media.ts'
import { VERSION } from '../version.ts'
import { serveWebApp } from '../web/static.ts'
import { handleTunnel } from './tunnel.ts'
import {
  createRpcRouter,
  type AutomationServices,
  type RpcContext,
  type WorkspaceServices,
  type RelayControl,
} from './rpc.ts'

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
function readJson(req: IncomingMessage, limit = 4096): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!req.headers['content-type']?.startsWith('application/json')) {
      return reject(new Error('content-type'))
    }
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
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
  /** Folder holding the built web app, to serve at `/`; the host serves only its API without one. */
  webRoot?: string
  store: EventStore
  sessions: SessionManager
  agents: AgentCatalog
  attachments: AttachmentStore
  workspace: WorkspaceServices
  watchers: FileWatchers
  tokens: TokenStore
  pairing: PairingManager
  tailscale: TailscaleService
  /** Where other devices can reach this host, for pairing links. */
  reachable?: () => Promise<{ hostId: string; name: string; routes: string[]; relay?: string }>
  /** Reads and changes the relay this host is reachable through. */
  relay?: RelayControl
  automation: AutomationServices
  /** Answers BeddCode's agent tools for sessions that may use them (loopback only). */
  agentTools?: AgentTools
  /** Runs agents' browser tools on connected desktop apps. */
  browser?: BrowserBroker
  /** Pictures of designs for agents, drawn by connected apps, and what they have selected. */
  designLink?: DesignLink
  /** Who may connect; defaults to this machine plus the tailnet, tokens for everyone else. */
  guard?: GuardOptions
  log: Logger
  /**
   * A connection silent for this long is closed. Clients ping every 15 s; past half of this one
   * that has said nothing is pinged at the socket level, which any client answers.
   */
  idleTimeoutMs?: number
}

/**
 * What a connection needs from its socket. A `ws` WebSocket does; so does the stand-in for a
 * device that arrives through a relay (see relay/agent.ts).
 */
export interface ConnSocket {
  readonly readyState: number
  readonly OPEN: number
  readonly bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
  on(event: 'pong' | 'close', listener: () => void): unknown
  on(event: 'message', listener: (raw: unknown) => void): unknown
}

export interface RunningServer {
  port: number
  hostInfo: HostInfo
  /** Serves a connection that did not come in through this host's own listener (a relay's). */
  attach(socket: ConnSocket, peer: PeerClass): void
  close(): Promise<void>
}

const REPLAY_BATCH = 1000
/** How long a repeated request (same `rid`) still gets the first answer. */
const REPEAT_TTL_MS = 5 * 60_000
const REPEAT_MAX = 1000

type Outcome = { ok: true; result: unknown } | { ok: false; error: string }
const IDLE_TIMEOUT_MS = 45_000

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
  /** Requests that carry a `rid`: the work runs once, a repeat after a reconnect gets its answer. */
  const repeats = new Map<string, { at: number; outcome: Promise<Outcome> }>()
  const runOnce = (key: string, run: () => Promise<unknown>): Promise<Outcome> => {
    const now = Date.now()
    for (const [k, v] of repeats) {
      if (now - v.at > REPEAT_TTL_MS || repeats.size > REPEAT_MAX) repeats.delete(k)
      else break
    }
    const known = repeats.get(key)
    if (known) return known.outcome
    const outcome = run().then(
      (result): Outcome => ({ ok: true, result }),
      (err: unknown): Outcome => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    repeats.set(key, { at: now, outcome })
    return outcome
  }
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
      reachable: options.reachable,
      relay: options.relay,
    },
    options.automation,
  )

  const http = createServer((req, res) => {
    const peer = classifyRequest(req.socket.remoteAddress, req.headers)
    const origin = req.headers.origin
    const url = (req.url ?? '').split('?')[0]

    if (!peerAllowed(peer, guard)) {
      res.writeHead(403).end()
      return
    }
    // Answers to pages we allow; other origins get no CORS headers and so cannot read anything.
    if (origin && originAllowed(origin, guard, req.headers.host)) {
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

    // Images, video and audio for the Files pane. The ticket in the address is the credential.
    if (url?.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      void serveMedia(options.workspace.files.media, url.slice('/media/'.length), req, res)
      return
    }

    if (url === '/pair' && req.method === 'POST') {
      if (!originAllowed(origin, guard, req.headers.host)) return void res.writeHead(403).end()
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

    // The agent tools' MCP bridge, run by an agent on this machine with its session's key.
    if (url === '/agent-tools' && req.method === 'POST') {
      if (peer !== 'loopback' || origin !== undefined || !options.agentTools)
        return void res.writeHead(403).end()
      const auth = req.headers.authorization
      const sessionId = options.agentTools.sessionFor(
        auth?.startsWith('Bearer ') ? auth.slice(7) : undefined,
      )
      if (!sessionId) return reply(res, 401, { error: 'Unknown session key' })
      const tools = options.agentTools
      void readJson(req, 8 * 1024 * 1024)
        .then(async (body) => {
          const { method, params } = (body ?? {}) as { method?: unknown; params?: unknown }
          if (typeof method !== 'string') return reply(res, 400, { error: 'Send {method, params}' })
          try {
            reply(res, 200, { result: await tools.handle(sessionId, method, params) })
          } catch (err) {
            reply(res, 200, { error: err instanceof Error ? err.message : String(err) })
          }
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
    // The web app itself, for the desktop app and for a browser on this machine or the tailnet.
    if (options.webRoot && url !== undefined && serveWebApp(options.webRoot, req, res, url)) return
    res.writeHead(404).end()
  })

  // Refuse before the upgrade completes: wrong network, or a web page that is not ours.
  const verifyClient: NonNullable<ServerOptions['verifyClient']> = ({ req }, done) => {
    const peer = classifyRequest(req.socket.remoteAddress, req.headers)
    if (!peerAllowed(peer, guard)) return done(false, 403, 'network')
    if (!originAllowed(req.headers.origin, guard, req.headers.host))
      return done(false, 403, 'origin')
    done(true)
  }
  const wss = new WebSocketServer({ noServer: true, verifyClient })
  // The desktop app's port forwarding for its browser pane (see tunnel.ts).
  const tunnels = new WebSocketServer({ noServer: true, verifyClient, perMessageDeflate: false })
  http.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    const server = path === '/ws' ? wss : path === '/tunnel' ? tunnels : null
    if (!server) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    server.handleUpgrade(req, socket, head, (ws) => server.emit('connection', ws, req))
  })
  wss.on('connection', (ws, req) =>
    handleConnection(
      ws as unknown as ConnSocket,
      classifyRequest(req.socket.remoteAddress, req.headers),
    ),
  )
  tunnels.on('connection', (ws, req) =>
    handleTunnel(ws, {
      needsToken: needsToken(classifyRequest(req.socket.remoteAddress, req.headers), guard),
      verifyToken: (token) => options.tokens.verify(token),
      onRevoke: (listener) => options.tokens.onRevoke(listener),
      ownPort: () => listeningPort,
      log,
    }),
  )

  // A laptop that slept or a phone that lost its network leaves a socket that never closes on its
  // own; its subscriptions, terminals and watchers would stay attached. Close the silent ones.
  const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const lastSeen = new Map<ConnSocket, number>()
  const sweep = setInterval(
    () => {
      const now = Date.now()
      for (const [ws, seen] of lastSeen) {
        const quiet = now - seen
        if (quiet >= idleMs) {
          log.debug('closing a connection that went silent')
          lastSeen.delete(ws)
          ws.terminate()
        } else if (quiet >= idleMs / 2 && ws.readyState === ws.OPEN) {
          ws.ping()
        }
      }
    },
    Math.max(10, Math.floor(idleMs / 4)),
  )
  sweep.unref()

  function handleConnection(ws: ConnSocket, peer: PeerClass) {
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
    // Joins the browser broker once it offers (the desktop app does).
    const browserClient = options.browser?.connect(send)
    const designClient = options.designLink?.connect(send)
    // Design canvases saved by anyone, so open editors can refresh.
    const stopDesigns = options.automation.designs.onChange((c) => {
      if (authed) send({ t: 'design.changed', ...c })
    })
    lastSeen.set(ws, Date.now())
    const alive = () => {
      if (lastSeen.has(ws)) lastSeen.set(ws, Date.now())
    }
    ws.on('pong', alive)
    // What this connection is attached to, released when it goes away.
    const terminalDetach = new Map<string, () => void>()
    const watching = new Map<string, () => void>()
    const terminalClient = {
      send: (frame: ServerFrame) => send(frame),
      backlog: () => ws.bufferedAmount,
    }
    ws.on('close', () => {
      lastSeen.delete(ws)
      stopOnRevoke()
      unsubscribe?.()
      terminalDetach.forEach((detach) => detach())
      watching.forEach((release) => release())
      browserClient?.close()
      designClient?.close()
      stopDesigns()
    })

    ws.on('message', (raw) => {
      alive()
      let frame: ClientFrame
      try {
        frame = ClientFrame.parse(JSON.parse(String(raw)))
      } catch {
        ws.close(1003, 'invalid frame')
        return
      }

      if (!authed && frame.t === 'pair') {
        const outcome = options.pairing.redeem(frame.code)
        if (outcome === 'ok') {
          const { token, device } = options.tokens.issue(frame.deviceName)
          log.info(`paired device "${device.name}" over a relay`)
          send({ t: 'paired', token, host: hostInfo })
        } else {
          send({
            t: 'pair.failed',
            error:
              outcome === 'locked'
                ? 'Too many wrong codes. Wait a minute and ask for a new one.'
                : 'That code is wrong or has expired',
          })
        }
        return
      }

      if (!authed) {
        const device = frame.t === 'hello' ? options.tokens.verify(frame.token) : null
        if (device) {
          authed = true
          deviceId = device.id
          context.deviceId = device.id
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
        case 'req': {
          const run = () => dispatch(frame.method, frame.params, context)
          const outcome = frame.rid
            ? runOnce(`${deviceId ?? 'local'}:${frame.rid}`, run)
            : run().then(
                (result): Outcome => ({ ok: true, result }),
                (err: unknown): Outcome => ({
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                }),
              )
          void outcome.then((o) =>
            send(
              o.ok
                ? { t: 'res', id: frame.id, ok: true, result: o.result }
                : { t: 'res', id: frame.id, ok: false, error: o.error },
            ),
          )
          break
        }
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
        case 'design.view':
        case 'design.rendered':
        case 'design.imported':
        case 'design.laidout':
          designClient?.frame(frame)
          break
        case 'browser.offer':
        case 'browser.result':
          browserClient?.frame(frame)
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
    attach: handleConnection,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep)
        for (const client of wss.clients) client.terminate()
        for (const client of tunnels.clients) client.terminate()
        tunnels.close()
        wss.close(() => http.close(() => resolve()))
      }),
  }
}
