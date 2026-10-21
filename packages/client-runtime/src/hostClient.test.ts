import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerFrame, StoredEvent } from '@beddcode/contracts'
import { HostClient } from './hostClient.ts'

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.drop()
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  receive(frame: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop() {
    this.readyState = 3
    this.onclose?.()
  }
}

const host = { hostId: 'h', name: 'n', platform: 'linux' as const, version: '0' }
const welcome: ServerFrame = { t: 'welcome', protocol: 1, host }
const ev = (seq: number): StoredEvent => ({
  seq,
  event: { type: 'turn.started', sessionId: 's', at: seq },
})

beforeEach(() => {
  FakeSocket.instances = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

function makeClient(onEvent: (e: StoredEvent) => void) {
  return new HostClient({
    url: 'ws://host/ws',
    onEvent,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    backoff: { minMs: 100, maxMs: 100 },
  })
}

describe('HostClient', () => {
  it('subscribes after the handshake and reports events once', () => {
    const seen: number[] = []
    const client = makeClient((e) => seen.push(e.seq))
    client.start()
    const ws = FakeSocket.instances[0]!
    ws.open()
    ws.receive(welcome)
    expect(ws.sent.at(-1)).toEqual({ t: 'subscribe', afterSeq: 0 })

    ws.receive({ t: 'event', stored: ev(1) })
    ws.receive({ t: 'event', stored: ev(2) })
    ws.receive({ t: 'event', stored: ev(2) })
    expect(seen).toEqual([1, 2])
  })

  it('reconnects and resumes after the last seen seq', () => {
    const seen: number[] = []
    const client = makeClient((e) => seen.push(e.seq))
    client.start()
    const first = FakeSocket.instances[0]!
    first.open()
    first.receive(welcome)
    first.receive({ t: 'event', stored: ev(5) })
    first.drop()
    expect(client.connectionState).toBe('reconnecting')

    vi.advanceTimersByTime(200)
    const second = FakeSocket.instances[1]!
    second.open()
    second.receive(welcome)
    expect(second.sent.at(-1)).toEqual({ t: 'subscribe', afterSeq: 5 })
    second.receive({ t: 'event', stored: ev(5) })
    second.receive({ t: 'event', stored: ev(6) })
    expect(seen).toEqual([5, 6])
  })

  it('resolves requests and rejects them when the connection drops', async () => {
    const client = makeClient(() => {})
    client.start()
    const ws = FakeSocket.instances[0]!
    ws.open()
    ws.receive(welcome)

    const ok = client.request('sessions.interrupt', { sessionId: 's' })
    const reqId = (ws.sent.at(-1) as { id: string }).id
    ws.receive({ t: 'res', id: reqId, ok: true, result: {} })
    await expect(ok).resolves.toEqual({})

    const lost = client.request('sessions.interrupt', { sessionId: 's' })
    ws.drop()
    await expect(lost).rejects.toThrow('connection lost')
    await expect(client.request('sessions.interrupt', { sessionId: 's' })).rejects.toThrow(
      'not connected',
    )
  })

  it('forwards terminal and file frames, and sends frames only while connected', () => {
    const frames: string[] = []
    const client = new HostClient({
      url: 'ws://host/ws',
      onEvent: () => {},
      onFrame: (f) => frames.push(f.t),
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    })
    expect(client.send({ t: 'term.attach', id: 'a' })).toBe(false)
    client.start()
    const ws = FakeSocket.instances[0]!
    ws.open()
    expect(client.send({ t: 'term.attach', id: 'a' })).toBe(false) // handshake not finished
    ws.receive(welcome)
    expect(client.send({ t: 'term.attach', id: 'a' })).toBe(true)
    expect(ws.sent.at(-1)).toEqual({ t: 'term.attach', id: 'a' })

    ws.receive({ t: 'term.out', id: 'a', data: 'x' })
    ws.receive({ t: 'term.exit', id: 'a', code: 0 })
    ws.receive({ t: 'fs.changed', cwd: '/w', paths: ['a.ts'] })
    expect(frames).toEqual(['term.out', 'term.exit', 'fs.changed'])
  })

  it('does not reconnect after stop()', () => {
    const client = makeClient(() => {})
    client.start()
    FakeSocket.instances[0]!.open()
    client.stop()
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})
