import net from 'node:net'

/**
 * Forwards a port on a remote host to this computer, for the browser pane: an agent's dev server
 * at `localhost:5173` on the host shows at `localhost:5173` here (or another free port). Each local
 * connection travels over its own WebSocket to the host's `/tunnel` (apps/server/src/transport/
 * tunnel.ts), which connects to the port on its own loopback.
 */

/** The part of the WHATWG WebSocket this needs (Node's global one in Electron's main process). */
export interface TunnelSocket {
  binaryType: string
  readonly bufferedAmount: number
  readonly readyState: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

export type Dial = (url: string) => TunnelSocket

/** The host's tunnel address for one of its WebSocket routes (`ws://h:3773/ws`). */
export function tunnelUrl(route: string): string {
  const url = new URL(route.replace(/^http/i, 'ws'))
  url.pathname = '/tunnel'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export interface ForwardRequest {
  /** One of the host's WebSocket routes, as the app connects to it. */
  route: string
  /** The paired device's token for that host, when it needs one. */
  token?: string
  /** The port on the host. */
  port: number
}

interface Forward {
  localPort: number
  servers: net.Server[]
  sockets: Set<net.Socket>
}

const HIGH_WATER = 4 * 1024 * 1024
const OPEN = 1

function listen(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.once('error', onError)
    server.listen({ port, host, exclusive: true }, () => {
      server.off('error', onError)
      resolve((server.address() as net.AddressInfo).port)
    })
  })
}

const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()))

export class PortForwards {
  private forwards = new Map<string, Promise<Forward>>()

  constructor(private readonly dial: Dial = (url) => new WebSocket(url) as TunnelSocket) {}

  /** Starts forwarding (or reuses a forward already running); resolves to the local port. */
  async forward(request: ForwardRequest): Promise<number> {
    const key = `${tunnelUrl(request.route)}|${request.port}`
    let pending = this.forwards.get(key)
    if (!pending) {
      pending = this.start(request)
      this.forwards.set(key, pending)
      pending.catch(() => this.forwards.delete(key))
    }
    return (await pending).localPort
  }

  /** Stops every forward and drops their connections. */
  async closeAll(): Promise<void> {
    const all = [...this.forwards.values()]
    this.forwards.clear()
    for (const pending of all) {
      const forward = await pending.catch(() => null)
      if (!forward) continue
      forward.sockets.forEach((s) => s.destroy())
      await Promise.all(forward.servers.map(close))
    }
  }

  private async start(request: ForwardRequest): Promise<Forward> {
    const sockets = new Set<net.Socket>()
    const onConnection = (socket: net.Socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      this.pipe(socket, request)
    }
    // The same port number when it is free here, so addresses (and the cookies and settings tied
    // to them) stay the same. Both loopbacks: Chromium may try ::1 before 127.0.0.1 for localhost.
    for (const wanted of [request.port, 0]) {
      const v4 = net.createServer(onConnection)
      let port: number
      try {
        port = await listen(v4, wanted, '127.0.0.1')
      } catch {
        continue
      }
      const v6 = net.createServer(onConnection)
      try {
        await listen(v6, port, '::1')
        return { localPort: port, servers: [v4, v6], sockets }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        // No IPv6 loopback on this computer: 127.0.0.1 alone is all there is.
        if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
          return { localPort: port, servers: [v4], sockets }
        }
        await close(v4)
      }
    }
    throw new Error(`Could not open a local port for port ${request.port}`)
  }

  private pipe(socket: net.Socket, request: ForwardRequest) {
    socket.setNoDelay(true)
    let ws: TunnelSocket
    try {
      ws = this.dial(tunnelUrl(request.route))
    } catch {
      socket.destroy()
      return
    }
    ws.binaryType = 'arraybuffer'
    let ready = false
    const queued: Buffer[] = []
    const send = (chunk: Buffer) => {
      ws.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      if (ws.bufferedAmount > HIGH_WATER) {
        socket.pause()
        const resume = () => {
          if (ws.readyState !== OPEN) return
          if (ws.bufferedAmount > HIGH_WATER / 2) setTimeout(resume, 10)
          else socket.resume()
        }
        setTimeout(resume, 10)
      }
    }
    socket.on('data', (chunk) => (ready ? send(chunk) : queued.push(chunk)))
    socket.on('error', () => ws.close())
    socket.on('close', () => ws.close())
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ t: 'open', port: request.port, token: request.token })),
    )
    ws.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') {
        if (!ready && data === '{"t":"ok"}') {
          ready = true
          queued.splice(0).forEach(send)
        } else socket.destroy()
        return
      }
      if (!ready) return
      const bytes =
        data instanceof ArrayBuffer
          ? Buffer.from(data)
          : ArrayBuffer.isView(data)
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            : null
      if (bytes) socket.write(bytes)
    })
    ws.addEventListener('close', () => socket.end())
    ws.addEventListener('error', () => socket.destroy())
  }
}
