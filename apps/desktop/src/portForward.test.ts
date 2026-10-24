import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { PortForwards, tunnelUrl, type TunnelSocket } from './portForward.ts'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** Stands in for the host's /tunnel: connects to the requested port on this machine. */
function fakeHost(seen: { url: string; open?: unknown }[]) {
  return (url: string): TunnelSocket => {
    const listeners: Record<string, ((e: { data: unknown }) => void)[]> = {}
    const emit = (type: string, data?: unknown) => listeners[type]?.forEach((l) => l({ data }))
    let target: net.Socket | null = null
    const entry: { url: string; open?: unknown } = { url }
    seen.push(entry)
    const ws: TunnelSocket = {
      binaryType: 'blob',
      bufferedAmount: 0,
      readyState: 1,
      send(data) {
        if (typeof data === 'string') {
          entry.open = JSON.parse(data)
          const { port } = entry.open as { port: number }
          target = net.connect(port, '127.0.0.1', () => emit('message', '{"t":"ok"}'))
          target.on('data', (d) =>
            emit('message', d.buffer.slice(d.byteOffset, d.byteOffset + d.length)),
          )
          target.on('close', () => emit('close'))
        } else target?.write(data)
      },
      close() {
        target?.destroy()
      },
      addEventListener(type: string, listener: (e: { data: unknown }) => void) {
        ;(listeners[type] ??= []).push(listener)
      },
    }
    queueMicrotask(() => emit('open'))
    return ws
  }
}

async function echoServer() {
  const server = net.createServer((s) => s.on('data', (d) => s.write(String(d).toUpperCase())))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise((resolve) => server.close(resolve)))
  return (server.address() as net.AddressInfo).port
}

function roundTrip(port: number, text: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text))
    socket.once('data', (d) => {
      resolve(String(d))
      socket.destroy()
    })
    socket.once('error', reject)
  })
}

describe('tunnelUrl', () => {
  it('points any route of the host at its tunnel', () => {
    expect(tunnelUrl('ws://box:3773/ws')).toBe('ws://box:3773/tunnel')
    expect(tunnelUrl('wss://box.tail.ts.net/ws?x=1')).toBe('wss://box.tail.ts.net/tunnel')
    expect(tunnelUrl('http://100.64.0.2:3773')).toBe('ws://100.64.0.2:3773/tunnel')
  })
})

describe('PortForwards', () => {
  it('forwards a local port to the host, sending the token, and reuses the forward', async () => {
    const remote = await echoServer()
    const seen: { url: string; open?: unknown }[] = []
    const forwards = new PortForwards(fakeHost(seen))
    cleanup.push(() => forwards.closeAll())
    const request = { route: 'ws://box:3773/ws', token: 'tok', port: remote }
    const local = await forwards.forward(request)
    expect(await forwards.forward(request)).toBe(local)
    expect(await roundTrip(local, 'hi')).toBe('HI')
    expect(seen[0]).toMatchObject({
      url: 'ws://box:3773/tunnel',
      open: { t: 'open', port: remote, token: 'tok' },
    })
  })

  it('picks another local port when the same number is taken here', async () => {
    const remote = await echoServer()
    // The remote port's number is in use on this computer (by the echo server itself).
    const forwards = new PortForwards(fakeHost([]))
    cleanup.push(() => forwards.closeAll())
    const local = await forwards.forward({ route: 'ws://box:3773/ws', port: remote })
    expect(local).not.toBe(remote)
    expect(await roundTrip(local, 'abc')).toBe('ABC')
  })
})
