import net from 'node:net'
import type { WebSocket } from 'ws'
import type { Logger } from '@beddcode/shared'

/**
 * Port forwarding for the desktop app's browser pane. A page the agent serves on the host
 * (`localhost:5173`) is not reachable from the laptop showing it, so the desktop app opens a local
 * port and carries each connection to the host over a WebSocket at `/tunnel`. The host connects to
 * the port on its own loopback and pipes bytes both ways; HTTP, WebSockets (HMR) and anything else
 * over TCP work unchanged.
 *
 * The first message is text, `{"t":"open","port":5173,"token":"…"}`. The host answers
 * `{"t":"ok"}` once connected, or `{"t":"error","message":"…"}` and closes. Every later message is
 * binary payload.
 */
export interface TunnelOptions {
  /** Whether this peer must prove a paired device's token (see auth/guard.ts). */
  needsToken: boolean
  /** The paired device a token belongs to, or null. */
  verifyToken(token: string | undefined): { id: string } | null
  /** Calls back when a device is revoked; returns an unsubscribe. */
  onRevoke(listener: (deviceId: string) => void): () => void
  /** The host's own port: never forwarded, so nothing reaches the host as this machine. */
  ownPort(): number
  log: Logger
  /** Pauses reading from the target while this much is still unsent on the socket. */
  highWaterMark?: number
}

const HIGH_WATER = 4 * 1024 * 1024
/** The first message must come quickly; a socket that never asks for a port is closed. */
const OPEN_TIMEOUT_MS = 10_000

/** Parses the opening request; null when it is not one. */
export function parseOpen(raw: string): { port: number; token?: string } | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { t, port, token } = value as Record<string, unknown>
  if (t !== 'open' || typeof port !== 'number' || !Number.isInteger(port)) return null
  if (port < 1 || port > 65535) return null
  return { port, token: typeof token === 'string' ? token : undefined }
}

export function handleTunnel(ws: WebSocket, options: TunnelOptions): void {
  const highWater = options.highWaterMark ?? HIGH_WATER
  let target: net.Socket | null = null
  let deviceId: string | undefined
  const fail = (message: string, code = 1011) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'error', message }))
    ws.close(code, message.slice(0, 120))
  }
  const timer = setTimeout(() => fail('no open request', 1008), OPEN_TIMEOUT_MS)
  const stopOnRevoke = options.onRevoke((id) => {
    if (id === deviceId) ws.close(1008, 'device revoked')
  })
  ws.on('close', () => {
    clearTimeout(timer)
    stopOnRevoke()
    target?.destroy()
  })
  ws.on('error', () => target?.destroy())

  ws.on('message', (data, isBinary) => {
    if (target) {
      if (!isBinary) return
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      // Writes that pile up pause the socket until the target drains.
      if (!target.write(chunk)) {
        ws.pause()
        target.once('drain', () => ws.resume())
      }
      return
    }
    if (isBinary) return fail('expected an open request', 1008)
    clearTimeout(timer)
    const open = parseOpen(String(data))
    if (!open) return fail('expected an open request', 1008)
    if (options.needsToken) {
      const device = options.verifyToken(open.token)
      if (!device) return fail('auth', 1008)
      deviceId = device.id
    }
    if (open.port === options.ownPort()) return fail('that port is the host itself', 1008)
    const socket = net.connect({ host: 'localhost', port: open.port, autoSelectFamily: true })
    target = socket
    socket.setNoDelay(true)
    socket.once('connect', () => {
      if (ws.readyState !== ws.OPEN) return void socket.destroy()
      ws.send(JSON.stringify({ t: 'ok' }))
    })
    socket.on('data', (chunk) => {
      if (ws.readyState !== ws.OPEN) return
      ws.send(chunk, { binary: true })
      if (ws.bufferedAmount > highWater) {
        socket.pause()
        const resume = () => {
          if (ws.readyState !== ws.OPEN) return
          if (ws.bufferedAmount > highWater / 2) setTimeout(resume, 10)
          else socket.resume()
        }
        setTimeout(resume, 10)
      }
    })
    socket.on('error', (err: NodeJS.ErrnoException) => {
      options.log.debug(`tunnel to port ${open.port}: ${err.code ?? err.message}`)
      fail(
        err.code === 'ECONNREFUSED'
          ? `Nothing is listening on port ${open.port} on the host`
          : `Could not reach port ${open.port} on the host`,
      )
    })
    socket.on('close', () => {
      if (ws.readyState === ws.OPEN) ws.close(1000, 'closed')
    })
  })
}
