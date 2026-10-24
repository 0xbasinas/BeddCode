import net from 'node:net'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createLogger } from '@beddcode/shared'
import { handleTunnel, parseOpen, type TunnelOptions } from './tunnel.ts'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** A TCP server on this machine that upper-cases what it receives. */
async function echoServer() {
  const server = net.createServer((socket) =>
    socket.on('data', (d) => socket.write(d.toString().toUpperCase())),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise((resolve) => server.close(resolve)))
  return (server.address() as net.AddressInfo).port
}

async function tunnelHost(overrides: Partial<TunnelOptions> = {}) {
  const revokes = new Set<(id: string) => void>()
  const http = createServer()
  const wss = new WebSocketServer({ server: http, path: '/tunnel' })
  wss.on('connection', (ws) =>
    handleTunnel(ws, {
      needsToken: false,
      verifyToken: (token) => (token === 'good' ? { id: 'dev-1' } : null),
      onRevoke: (listener) => {
        revokes.add(listener)
        return () => revokes.delete(listener)
      },
      ownPort: () => -1,
      log: createLogger('test', 'error'),
      ...overrides,
    }),
  )
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((resolve) => http.close(resolve))
  })
  const port = (http.address() as net.AddressInfo).port
  return { port, revoke: (id: string) => revokes.forEach((l) => l(id)) }
}

function open(hostPort: number, request: unknown) {
  const ws = new WebSocket(`ws://127.0.0.1:${hostPort}/tunnel`)
  cleanup.push(() => ws.terminate())
  const texts: string[] = []
  const bytes: Buffer[] = []
  const closed = new Promise<number>((resolve) => ws.once('close', resolve))
  const ok = new Promise<void>((resolve) =>
    ws.on('message', (data, binary) => {
      if (binary) bytes.push(data as Buffer)
      else {
        texts.push(String(data))
        if (String(data) === '{"t":"ok"}') resolve()
      }
    }),
  )
  ws.once('open', () => ws.send(JSON.stringify(request)))
  return { ws, texts, bytes, closed, ok }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('tunnel', () => {
  it('parses only well-formed open requests', () => {
    expect(parseOpen('{"t":"open","port":5173,"token":"x"}')).toEqual({ port: 5173, token: 'x' })
    expect(parseOpen('{"t":"open","port":5173}')).toEqual({ port: 5173 })
    expect(parseOpen('{"t":"open","port":0}')).toBeNull()
    expect(parseOpen('{"t":"open","port":70000}')).toBeNull()
    expect(parseOpen('{"t":"open","port":"80"}')).toBeNull()
    expect(parseOpen('{"t":"nope","port":80}')).toBeNull()
    expect(parseOpen('not json')).toBeNull()
  })

  it('carries bytes both ways to a port on the host', async () => {
    const target = await echoServer()
    const host = await tunnelHost()
    const t = open(host.port, { t: 'open', port: target })
    await t.ok
    t.ws.send(Buffer.from('hello'), { binary: true })
    await until(() => Buffer.concat(t.bytes).toString() === 'HELLO')
  })

  it('demands a token when the peer needs one, and closes on revoke', async () => {
    const target = await echoServer()
    const host = await tunnelHost({ needsToken: true })
    const anon = open(host.port, { t: 'open', port: target })
    expect(await anon.closed).toBe(1008)
    expect(anon.texts[0]).toContain('auth')

    const good = open(host.port, { t: 'open', port: target, token: 'good' })
    await good.ok
    host.revoke('dev-1')
    expect(await good.closed).toBe(1008)
  })

  it('refuses the host itself and says when nothing listens', async () => {
    const target = await echoServer()
    const self = await tunnelHost({ ownPort: () => target })
    const refused = open(self.port, { t: 'open', port: target })
    expect(await refused.closed).toBe(1008)

    const host = await tunnelHost()
    // A port that was just closed is very likely free.
    const probe = net.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const dead = (probe.address() as net.AddressInfo).port
    await new Promise((resolve) => probe.close(resolve))
    const nothing = open(host.port, { t: 'open', port: dead })
    await nothing.closed
    expect(nothing.texts.join()).toMatch(/Nothing is listening|Could not reach/)
  })
})
