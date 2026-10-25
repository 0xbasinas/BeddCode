import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  Reassembler,
  SecureChannel,
  chunks,
  fromBase64,
  newRelayKey,
  randomBytes,
  toBase64,
} from '@beddcode/client-runtime/relayCrypto'
import { RelaySocket, buildRelayRoute, parseRelayRoute } from '@beddcode/client-runtime/relaySocket'
import { startRelay, type RunningRelay } from './node.ts'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** Set RELAY_TEST_PORT to run these against an already-running relay (e.g. `wrangler dev`). */
async function boot(): Promise<RunningRelay> {
  if (process.env.RELAY_TEST_PORT)
    return { port: Number(process.env.RELAY_TEST_PORT), close: async () => {} }
  const relay = await startRelay({ port: 0, host: '127.0.0.1' })
  cleanup.push(() => relay.close())
  return relay
}

const nextMessage = (ws: WebSocket) =>
  new Promise<string>((resolve) => ws.once('message', (m) => resolve(String(m))))
const opened = (ws: WebSocket) => new Promise<void>((resolve) => ws.once('open', () => resolve()))
const closed = (ws: WebSocket) =>
  new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))

/** A minimal host: claims its room and answers each device with the same handshake the server's agent uses. */
async function fakeHost(port: number, route: ReturnType<typeof parseRelayRoute> & object) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/host/${route.room}`)
  cleanup.push(() => ws.terminate())
  await opened(ws)
  ws.send(JSON.stringify({ t: 'host', auth: route.auth }))
  expect(JSON.parse(await nextMessage(ws))).toEqual({ t: 'ready' })
  const channels = new Map<string, { channel?: SecureChannel; pieces: Reassembler }>()
  const received: string[] = []
  ws.on('message', (raw) => {
    const f = JSON.parse(String(raw)) as {
      t: string
      c: string
      n?: string
      d?: string
      f?: boolean
    }
    if (f.t === 'open') channels.set(f.c, { pieces: new Reassembler() })
    const peer = channels.get(f.c)
    if (!peer) return
    if (f.t === 'hi') {
      const hostNonce = randomBytes(16)
      peer.channel = new SecureChannel(route.key, fromBase64(f.n!), hostNonce, 'host')
      ws.send(JSON.stringify({ t: 'hi', c: f.c, n: toBase64(hostNonce) }))
    } else if (f.t === 'm' && peer.channel) {
      const whole = peer.pieces.push(f.d!, f.f === true)
      if (whole === null) return
      const text = peer.channel.open(whole)
      received.push(text)
      for (const part of chunks(peer.channel.seal(`echo:${text}`)))
        ws.send(JSON.stringify({ t: 'm', c: f.c, d: part.d, f: part.f }))
    }
  })
  return { ws, received }
}

const deviceSocket = (relayPort: number, key: string) => {
  const route = buildRelayRoute(`ws://127.0.0.1:${relayPort}`, key)
  return new RelaySocket(route)
}

describe('relay', () => {
  it('carries encrypted messages between a host and a device, including large ones', async () => {
    const relay = await boot()
    const key = newRelayKey()
    const route = parseRelayRoute(buildRelayRoute(`ws://127.0.0.1:${relay.port}`, key))!
    const host = await fakeHost(relay.port, route)

    const device = deviceSocket(relay.port, key)
    const replies: string[] = []
    device.onmessage = (m) => replies.push(m.data)
    await new Promise<void>((resolve) => (device.onopen = () => resolve()))
    device.send('hello')
    device.send('x'.repeat(200_000))
    await expect.poll(() => replies.length).toBe(2)
    expect(replies[0]).toBe('echo:hello')
    expect(replies[1]).toBe(`echo:${'x'.repeat(200_000)}`)
    expect(host.received[1]).toHaveLength(200_000)
    device.close()
  })

  it('never shows the relay a readable message', async () => {
    const relay = await boot()
    const key = newRelayKey()
    const route = parseRelayRoute(buildRelayRoute(`ws://127.0.0.1:${relay.port}`, key))!
    await fakeHost(relay.port, route)

    // A device that only watches the wire sees ciphertext.
    const seen: string[] = []
    const device = new RelaySocket(buildRelayRoute(`ws://127.0.0.1:${relay.port}`, key), (url) => {
      const ws = new WebSocket(url) as unknown as globalThis.WebSocket
      const send = ws.send.bind(ws)
      ws.send = (data: string) => (seen.push(String(data)), send(data))
      return ws
    })
    await new Promise<void>((resolve) => (device.onopen = () => resolve()))
    device.send('top secret prompt')
    await new Promise((r) => setTimeout(r, 50))
    expect(seen.join('')).not.toContain('top secret')
    device.close()
  })

  it('refuses a device that does not hold the key', async () => {
    const relay = await boot()
    const key = newRelayKey()
    const route = parseRelayRoute(buildRelayRoute(`ws://127.0.0.1:${relay.port}`, key))!
    await fakeHost(relay.port, route)

    // Same room, wrong key: the rooms differ, so it finds no host at all.
    const stranger = deviceSocket(relay.port, newRelayKey())
    const end = new Promise<void>((resolve) => (stranger.onclose = () => resolve()))
    await end
    expect(stranger.readyState).toBe(3)
  })

  it('keeps a room for the first host that claimed it', async () => {
    const relay = await boot()
    const key = newRelayKey()
    const route = parseRelayRoute(buildRelayRoute(`ws://127.0.0.1:${relay.port}`, key))!
    await fakeHost(relay.port, route)

    const squatter = new WebSocket(`ws://127.0.0.1:${relay.port}/host/${route.room}`)
    cleanup.push(() => squatter.terminate())
    await opened(squatter)
    squatter.send(JSON.stringify({ t: 'host', auth: 'not-the-owner' }))
    expect(await closed(squatter)).toBe(4401)
  })

  it('turns devices away while the host is offline, and drops them when it leaves', async () => {
    const relay = await boot()
    const key = newRelayKey()
    const route = parseRelayRoute(buildRelayRoute(`ws://127.0.0.1:${relay.port}`, key))!

    const early = new WebSocket(`ws://127.0.0.1:${relay.port}/client/${route.room}`)
    cleanup.push(() => early.terminate())
    early.on('error', () => {})
    // Closed with 4404, or (on Cloudflare) refused before the upgrade, which reads as 1006.
    expect([4404, 1006]).toContain(await closed(early))

    const host = await fakeHost(relay.port, route)
    const device = deviceSocket(relay.port, key)
    await new Promise<void>((resolve) => (device.onopen = () => resolve()))
    const gone = new Promise<void>((resolve) => (device.onclose = () => resolve()))
    host.ws.close()
    await gone
    expect(device.readyState).toBe(3)
  })

  it('lets only hosts with the password open a room, but devices need none', async () => {
    const relay = await startRelay({ port: 0, host: '127.0.0.1', hostPassword: 's3cret' })
    cleanup.push(() => relay.close())
    const key = newRelayKey()
    const route = parseRelayRoute(buildRelayRoute(`ws://127.0.0.1:${relay.port}`, key))!

    const stranger = new WebSocket(`ws://127.0.0.1:${relay.port}/host/${route.room}`)
    cleanup.push(() => stranger.terminate())
    const refused = await new Promise<string>((resolve) => {
      stranger.once('unexpected-response', (_req, res) => resolve(String(res.statusCode)))
      stranger.once('open', () => resolve('open'))
      stranger.once('error', () => {})
    })
    expect(refused).toBe('401')

    const host = new WebSocket(`ws://127.0.0.1:${relay.port}/host/${route.room}`, {
      headers: { authorization: 'Bearer s3cret' },
    })
    cleanup.push(() => host.terminate())
    await opened(host)
    host.send(JSON.stringify({ t: 'host', auth: route.auth }))
    expect(JSON.parse(await nextMessage(host))).toEqual({ t: 'ready' })
    const device = new WebSocket(`ws://127.0.0.1:${relay.port}/client/${route.room}`)
    cleanup.push(() => device.terminate())
    await opened(device)
  })

  it('rejects bad paths and malformed frames', async () => {
    const relay = await boot()
    const bad = new WebSocket(`ws://127.0.0.1:${relay.port}/nope`)
    cleanup.push(() => bad.terminate())
    await new Promise<void>((resolve) => bad.once('error', () => resolve()))

    const key = newRelayKey()
    const route = parseRelayRoute(buildRelayRoute(`ws://127.0.0.1:${relay.port}`, key))!
    const host = new WebSocket(`ws://127.0.0.1:${relay.port}/host/${route.room}`)
    cleanup.push(() => host.terminate())
    await opened(host)
    host.send('not json')
    expect(await closed(host)).toBe(4400)
  })
})
