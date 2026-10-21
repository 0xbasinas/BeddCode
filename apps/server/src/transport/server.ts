import { createServer } from 'node:http'
import os from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'
import { ClientFrame, PROTOCOL_VERSION, type HostInfo, type ServerFrame } from '@beddcode/contracts'
import type { Logger } from '@beddcode/shared'
import type { EventStore } from '../store/eventStore.ts'
import type { AgentCatalog } from '../agents/catalog.ts'
import type { AttachmentStore } from '../attachments/store.ts'
import type { SessionManager } from '../sessions/sessionManager.ts'
import type { FileWatchers } from '../files/watcher.ts'
import { createRpcRouter, type WorkspaceServices } from './rpc.ts'

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
  const dispatch = createRpcRouter(
    options.sessions,
    options.agents,
    options.attachments,
    options.workspace,
  )

  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, host: hostInfo }))
      return
    }
    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({ server: http, path: '/ws' })
  wss.on('connection', (ws) => handleConnection(ws))

  function handleConnection(ws: WebSocket) {
    const send = (frame: ServerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }
    let unsubscribe: (() => void) | null = null
    // What this connection is attached to, released when it goes away.
    const terminalDetach = new Map<string, () => void>()
    const watching = new Map<string, () => void>()
    const terminalClient = {
      send: (frame: ServerFrame) => send(frame),
      backlog: () => ws.bufferedAmount,
    }
    ws.on('close', () => {
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

      switch (frame.t) {
        case 'hello':
          send({ t: 'welcome', protocol: PROTOCOL_VERSION, host: hostInfo })
          break
        case 'req':
          dispatch(frame.method, frame.params).then(
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
