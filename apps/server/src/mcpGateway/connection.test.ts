import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayHostOptions } from './host.ts'

const sockets = vi.hoisted(() => ({ latest: undefined as unknown }))
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    static OPEN = 1
    readyState = 0
    constructor(
      _url: string,
      readonly options: unknown,
    ) {
      super()
      sockets.latest = this
    }
    terminate() {
      this.readyState = 3
      this.emit('close')
    }
    close() {
      this.readyState = 3
      this.emit('close')
    }
    ping = vi.fn()
  },
}))
import { GatewayHost } from './host.ts'

const options = {
  url: 'wss://example.test/host',
  secret: 'secret',
  home: '.',
  projects: async () => [],
  sessions: {},
  store: {},
  log: { info: vi.fn(), warn: vi.fn() },
} as unknown as GatewayHostOptions
afterEach(() => vi.useRealTimers())

describe('MCP gateway connection', () => {
  it('times out handshakes and explains an invalid host secret', () => {
    vi.useFakeTimers()
    const host = new GatewayHost(options)
    host.start()
    const socket = sockets.latest as EventEmitter & { options: { handshakeTimeout: number } }
    expect(socket.options.handshakeTimeout).toBe(10000)
    socket.emit('unexpected-response', {}, { statusCode: 401, resume: vi.fn() })
    expect(host.status).toBe('offline')
    expect(host.error).toContain('host secret')
    host.stop()
    expect(host.error).toBeUndefined()
  })

  it('clears an earlier error once the connection succeeds', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const host = new GatewayHost(options)
    host.start()
    let socket = sockets.latest as EventEmitter
    socket.emit('error', new Error('Opening handshake has timed out'))
    socket.emit('close')
    expect(host.error).toContain('timed out')
    vi.advanceTimersByTime(5000)
    socket = sockets.latest as EventEmitter
    socket.emit('open')
    expect(host.status).toBe('online')
    expect(host.error).toBeUndefined()
    host.stop()
    vi.restoreAllMocks()
  })

  it('reconnects when a connected socket stops answering heartbeats', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const host = new GatewayHost(options)
    host.start()
    const socket = sockets.latest as EventEmitter & {
      readyState: number
      ping: ReturnType<typeof vi.fn>
    }
    socket.readyState = 1
    socket.emit('open')
    vi.advanceTimersByTime(25000)
    expect(socket.ping).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(15000)
    expect(host.status).toBe('offline')
    expect(host.error).toContain('stopped responding')
    vi.advanceTimersByTime(5000)
    expect(sockets.latest).not.toBe(socket)
    host.stop()
    vi.restoreAllMocks()
  })

  it('keeps a healthy socket alive and stops heartbeats on disconnect', () => {
    vi.useFakeTimers()
    const host = new GatewayHost(options)
    host.start()
    const socket = sockets.latest as EventEmitter & {
      readyState: number
      ping: ReturnType<typeof vi.fn>
    }
    socket.readyState = 1
    socket.emit('open')
    vi.advanceTimersByTime(25000)
    socket.emit('pong')
    vi.advanceTimersByTime(15000)
    expect(host.status).toBe('online')
    host.stop()
    vi.advanceTimersByTime(60000)
    expect(socket.ping).toHaveBeenCalledOnce()
    expect(host.status).toBe('off')
  })

  it('does not fight another host that replaces this connection', () => {
    vi.useFakeTimers()
    const host = new GatewayHost(options)
    host.start()
    const socket = sockets.latest as EventEmitter
    socket.emit('close', 1000, Buffer.from('replaced'))
    expect(host.error).toContain('Another BeddCode host')
    vi.advanceTimersByTime(120000)
    expect(sockets.latest).toBe(socket)
    host.stop()
  })
})
