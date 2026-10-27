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
  it('measures how long the connection and the catch-up took', () => {
    const client = makeClient(() => {})
    client.start()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.receive(welcome)
    socket.receive({ t: 'event', stored: ev(1) })
    socket.receive({ t: 'event', stored: ev(2) })
    socket.receive({ t: 'caught-up', seq: 2 })
    const byName = Object.fromEntries(client.perf.recent.map((r) => [r.name, r]))
    expect(byName['connect.ms']?.tags).toEqual({ route: 'direct' })
    expect(byName['replay.events']).toMatchObject({ value: 2, tags: { resume: 'cold' } })
    expect(byName['replay.kb']!.value).toBeGreaterThan(0)
    expect(byName['replay.ms']).toBeDefined()
  })

  it.each([false, true])(
    'tries another route when stalled, socket open=%s, ignoring late frames',
    (opened) => {
      const seen: number[] = []
      const client = new HostClient({
        url: ['ws://stalled/ws', 'ws://working/ws'],
        onEvent: (e) => seen.push(e.seq),
        createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
        connectTimeoutMs: 500,
        backoff: { minMs: 100, maxMs: 100 },
      })
      client.start()
      client.start()
      expect(FakeSocket.instances).toHaveLength(1)
      const first = FakeSocket.instances[0]!
      if (opened) first.open() // TCP connects, but the host never welcomes us.
      vi.advanceTimersByTime(700)
      const second = FakeSocket.instances[1]!
      expect(second.url).toBe('ws://working/ws')
      second.open()
      second.receive(welcome)
      first.receive({ t: 'event', stored: ev(100) })
      second.receive({ t: 'event', stored: ev(1) })
      expect(seen).toEqual([1])
      client.stop()
      vi.advanceTimersByTime(10_000)
      expect(FakeSocket.instances).toHaveLength(2)
    },
  )

  it('does not connect to a different host or protocol on a saved route', () => {
    const client = new HostClient({
      url: ['ws://wrong/ws', 'ws://old/ws', 'ws://right/ws'],
      expectedHostId: host.hostId,
      onEvent: () => {},
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      backoff: { minMs: 100, maxMs: 100 },
    })
    client.start()
    const wrong = FakeSocket.instances[0]!
    wrong.open()
    wrong.receive({ ...welcome, host: { ...host, hostId: 'different' } })
    expect(client.connectionState).not.toBe('connected')
    vi.advanceTimersByTime(200)
    const old = FakeSocket.instances[1]!
    old.open()
    old.receive({ ...welcome, protocol: 99 })
    expect(client.connectionState).not.toBe('connected')
    vi.advanceTimersByTime(200)
    const right = FakeSocket.instances[2]!
    right.open()
    right.receive(welcome)
    expect(client.connectionState).toBe('connected')
    client.stop()
  })

  it('detects a silent network drop and reconnects without losing its replay cursor', () => {
    const client = new HostClient({
      url: 'ws://host/ws',
      onEvent: () => {},
      heartbeatMs: 500,
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      backoff: { minMs: 100, maxMs: 100 },
    })
    client.start()
    const first = FakeSocket.instances[0]!
    first.open()
    first.receive(welcome)
    first.receive({ t: 'event', stored: ev(7) })
    vi.advanceTimersByTime(500)
    expect(first.sent.at(-1)).toEqual({ t: 'ping' })
    first.receive({ t: 'pong' })
    vi.advanceTimersByTime(500)
    expect(client.connectionState).toBe('connected')
    // The next ping gets no answer, as when a machine goes to sleep.
    vi.advanceTimersByTime(700)
    const second = FakeSocket.instances[1]!
    second.open()
    second.receive(welcome)
    expect(second.sent.at(-1)).toEqual({ t: 'subscribe', afterSeq: 7, compact: true, batch: true })
    client.stop()
  })

  it('bounds unanswered requests and accepts later requests on the same connection', async () => {
    const client = new HostClient({
      url: 'ws://host/ws',
      onEvent: () => {},
      requestTimeoutMs: 500,
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    })
    client.start()
    const ws = FakeSocket.instances[0]!
    ws.open()
    ws.receive(welcome)
    const slow = client.request('providers.list', {})
    const rejected = expect(slow).rejects.toThrow('too long')
    vi.advanceTimersByTime(500)
    await rejected
    const next = client.request('providers.list', {})
    ws.receive({ t: 'res', id: String(ws.sent.at(-1)!.id), ok: true, result: [] })
    await expect(next).resolves.toEqual([])
    client.stop()
  })

  it('subscribes after the handshake and reports events once', () => {
    const seen: number[] = []
    const client = makeClient((e) => seen.push(e.seq))
    client.start()
    const ws = FakeSocket.instances[0]!
    ws.open()
    ws.receive(welcome)
    expect(ws.sent.at(-1)).toEqual({ t: 'subscribe', afterSeq: 0, compact: true, batch: true })

    ws.receive({ t: 'event', stored: ev(1) })
    ws.receive({ t: 'event', stored: ev(2) })
    ws.receive({ t: 'event', stored: ev(2) })
    expect(seen).toEqual([1, 2])
  })

  it('on wake, checks a connection that looks open and drops it when it does not answer', () => {
    const client = new HostClient({
      url: 'ws://host/ws',
      onEvent: () => {},
      probeTimeoutMs: 300,
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      backoff: { minMs: 100, maxMs: 100 },
    })
    client.start()
    const first = FakeSocket.instances[0]!
    first.open()
    first.receive(welcome)
    first.receive({ t: 'event', stored: ev(3) })
    // Still alive: it answers, nothing changes.
    client.reconnectNow()
    expect(first.sent.at(-1)).toEqual({ t: 'ping' })
    first.receive({ t: 'pong' })
    vi.advanceTimersByTime(400)
    expect(client.connectionState).toBe('connected')
    expect(FakeSocket.instances).toHaveLength(1)
    // After a sleep the socket is dead but nobody told us.
    client.reconnectNow()
    vi.advanceTimersByTime(300)
    expect(client.connectionState).toBe('reconnecting')
    vi.advanceTimersByTime(200)
    const second = FakeSocket.instances[1]!
    second.open()
    second.receive(welcome)
    expect(second.sent.at(-1)).toEqual({ t: 'subscribe', afterSeq: 3, compact: true, batch: true })
    client.stop()
  })

  it('on wake, skips the rest of a long back-off', () => {
    const client = new HostClient({
      url: 'ws://host/ws',
      onEvent: () => {},
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      backoff: { minMs: 60_000, maxMs: 60_000 },
      heartbeatMs: 1_000_000,
    })
    client.start()
    FakeSocket.instances[0]!.drop()
    expect(client.connectionState).toBe('reconnecting')
    vi.advanceTimersByTime(1_000)
    expect(FakeSocket.instances).toHaveLength(1)
    client.reconnectNow()
    expect(FakeSocket.instances).toHaveLength(2)
    // A second nudge while that attempt is under way does not start another.
    client.reconnectNow()
    expect(FakeSocket.instances).toHaveLength(2)
    const second = FakeSocket.instances[1]!
    second.open()
    second.receive(welcome)
    expect(client.connectionState).toBe('connected')
    // The skipped timer does not fire a stray attempt later.
    vi.advanceTimersByTime(120_000)
    expect(FakeSocket.instances).toHaveLength(2)
    client.stop()
    client.reconnectNow()
    expect(FakeSocket.instances).toHaveLength(2)
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
    expect(second.sent.at(-1)).toEqual({ t: 'subscribe', afterSeq: 5, compact: true, batch: true })
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

  it('sends a message again after a reconnect, under the same rid, and waits while offline', async () => {
    const client = makeClient(() => {})
    client.start()
    const first = FakeSocket.instances[0]!
    first.open()
    first.receive(welcome)

    const sent = client.request('sessions.prompt', { sessionId: 's', text: 'hi' })
    const req = first.sent.at(-1) as { id: string; rid?: string }
    expect(req.rid).toBeTruthy()
    first.drop()
    // Offline: nothing is sent yet, and the message keeps waiting.
    vi.advanceTimersByTime(50)
    await Promise.resolve()

    vi.advanceTimersByTime(200)
    const second = FakeSocket.instances[1]!
    second.open()
    second.receive(welcome)
    await Promise.resolve()
    const again = second.sent.find((f) => f.t === 'req') as { id: string; rid?: string }
    expect(again.rid).toBe(req.rid)
    second.receive({ t: 'res', id: again.id, ok: true, result: { ok: 1 } })
    await expect(sent).resolves.toEqual({ ok: 1 })

    // Started while offline: it goes out once connected.
    second.drop()
    const queued = client.request('sessions.prompt', { sessionId: 's', text: 'later' })
    vi.advanceTimersByTime(200)
    const third = FakeSocket.instances[2]!
    third.open()
    third.receive(welcome)
    await Promise.resolve()
    const out = third.sent.find((f) => f.t === 'req') as { id: string }
    third.receive({ t: 'res', id: out.id, ok: true, result: { ok: 2 } })
    await expect(queued).resolves.toEqual({ ok: 2 })
  })

  it('fails a waiting message when the connection does not come back in time', async () => {
    const client = new HostClient({
      url: 'ws://host/ws',
      onEvent: () => {},
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      backoff: { minMs: 100, maxMs: 100 },
      queueWaitMs: 1000,
    })
    client.start()
    const late = client.request('sessions.prompt', { sessionId: 's', text: 'x' })
    const failed = expect(late).rejects.toThrow('not connected')
    vi.advanceTimersByTime(1100)
    await failed
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

  it('sends the token in hello', () => {
    const client = new HostClient({
      url: 'ws://host/ws',
      token: 'secret',
      onEvent: () => {},
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    })
    client.start()
    const ws = FakeSocket.instances[0]!
    ws.open()
    expect(ws.sent[0]).toMatchObject({ t: 'hello', token: 'secret' })
  })

  it('stops for good when the host denies the token', () => {
    const states: string[] = []
    const client = new HostClient({
      url: 'ws://host/ws',
      token: 'revoked',
      onEvent: () => {},
      onState: (s) => states.push(s),
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      backoff: { minMs: 100, maxMs: 100 },
    })
    client.start()
    const ws = FakeSocket.instances[0]!
    ws.open()
    ws.receive({ t: 'denied', reason: 'auth' })
    vi.advanceTimersByTime(5000)
    expect(client.connectionState).toBe('denied')
    expect(states.at(-1)).toBe('denied')
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('falls back to the next route when one does not answer, and keeps the one that worked', () => {
    const client = new HostClient({
      url: ['ws://tailnet-name/ws', 'ws://100.1.2.3/ws'],
      onEvent: () => {},
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      backoff: { minMs: 100, maxMs: 100 },
    })
    client.start()
    expect(FakeSocket.instances[0]!.url).toBe('ws://tailnet-name/ws')
    FakeSocket.instances[0]!.drop() // never connected
    vi.advanceTimersByTime(200)
    expect(FakeSocket.instances[1]!.url).toBe('ws://100.1.2.3/ws')
    FakeSocket.instances[1]!.open()
    FakeSocket.instances[1]!.receive(welcome)
    expect(client.activeUrl).toBe('ws://100.1.2.3/ws')

    // A drop after a good connection retries the same address first.
    FakeSocket.instances[1]!.drop()
    vi.advanceTimersByTime(200)
    expect(FakeSocket.instances[2]!.url).toBe('ws://100.1.2.3/ws')
  })
  it('resumes from a saved copy of the history of the same log', () => {
    const client = new HostClient({
      url: 'ws://host/ws',
      onEvent: () => {},
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      initialSeq: 40,
      resumeLogId: 'log-1',
    })
    client.start()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.receive({ ...welcome, host: { ...host, logId: 'log-1' } })
    expect(socket.sent.find((f) => f.t === 'subscribe')).toEqual({
      t: 'subscribe',
      afterSeq: 40,
      compact: true,
      batch: true,
      logId: 'log-1',
    })
    socket.receive({ t: 'caught-up', seq: 40 })
    expect(client.perf.drain(50).find((r) => r.name === 'replay.ms')?.tags?.resume).toBe('disk')
  })

  it('subscribes right behind the hello, without waiting for the welcome', () => {
    const client = new HostClient({
      url: 'ws://host/ws',
      token: 't',
      onEvent: () => {},
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    })
    client.start()
    const socket = FakeSocket.instances[0]!
    socket.open()
    expect(socket.sent.map((f) => f.t)).toEqual(['hello', 'subscribe'])
    expect(socket.sent[1]).toMatchObject({ afterSeq: 0 })
    expect(socket.sent[1]).not.toHaveProperty('logId', expect.anything())
  })

  it('forgets a saved copy that belongs to another log, and asks for everything', () => {
    const reset = vi.fn()
    const client = new HostClient({
      url: 'ws://host/ws',
      onEvent: () => {},
      onReset: reset,
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      initialSeq: 40,
      resumeLogId: 'old-log',
    })
    client.start()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.receive({ ...welcome, host: { ...host, logId: 'new-log' } })
    expect(reset).toHaveBeenCalledOnce()
    // The subscription went out before the welcome, naming the old log; the host starts over for it.
    expect(socket.sent.find((f) => f.t === 'subscribe')).toMatchObject({
      afterSeq: 40,
      logId: 'old-log',
    })
    expect(client.seq).toBe(0)
    expect(client.log).toBe('new-log')
  })

  it('treats a host without a log id as a different log than a saved copy', () => {
    const reset = vi.fn()
    const client = new HostClient({
      url: 'ws://host/ws',
      onEvent: () => {},
      onReset: reset,
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      initialSeq: 9,
      resumeLogId: 'log-1',
    })
    client.start()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.receive(welcome)
    expect(reset).toHaveBeenCalledOnce()
  })

  it('resumes from where the replay ended, not from its last event', () => {
    const client = makeClient(() => {})
    client.start()
    const first = FakeSocket.instances[0]!
    first.open()
    first.receive(welcome)
    first.receive({ t: 'event', stored: ev(3) })
    first.receive({ t: 'caught-up', seq: 9 })
    expect(client.seq).toBe(9)
  })
})
