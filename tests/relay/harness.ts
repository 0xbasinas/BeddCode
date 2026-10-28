import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HostClient, type HostClientOptions } from '../../packages/client-runtime/src/hostClient.ts'
import { pairWithHost } from '../../packages/client-runtime/src/hostCatalog.ts'
import { parsePairLink } from '../../packages/client-runtime/src/pairLink.ts'
import {
  buildRelayRoute,
  isRelayRoute,
  pairViaRelay,
  parseRelayRoute,
  RelaySocket,
} from '../../packages/client-runtime/src/relaySocket.ts'
import { startRelay, type RunningRelay } from '../../packages/relay/src/node.ts'
import { freePort } from '../desktop/launch.ts'
import { Host } from '../shared/hostClient.ts'
import { LatencyProxy, type Shape } from './latencyProxy.ts'

export const root = path.resolve(import.meta.dirname, '../..')

export interface Profile extends Shape {
  name: string
  /** Round trip of each leg (device to relay, host to relay, device to host when direct). */
  rtt: number
}

/**
 * Every leg has the same round trip, so a relayed connection (device, relay, host) takes two legs
 * and a direct one takes one. That is the usual shape: a relay close to both ends, against a host
 * reached straight over a LAN or a tailnet.
 */
export const PROFILES: Profile[] = [
  { name: 'lan', rtt: 2, delayMs: 1 },
  { name: 'good', rtt: 40, delayMs: 20 },
  { name: 'mobile', rtt: 120, delayMs: 60, kbps: 8_000 },
  { name: 'poor', rtt: 300, delayMs: 150, kbps: 1_500 },
]

export interface Lab {
  /** The host's own address, for talking to it without any network in between. */
  local: { port: number; wsUrl: string; home: string }
  proxies: { direct: LatencyProxy; deviceToRelay: LatencyProxy; hostToRelay: LatencyProxy }
  /** The relay route a device uses (through its own leg). */
  relayRoute: string
  directUrl: string
  setProfile(profile: Profile): void
  resetBytes(): void
  newLocalClient(): Promise<Host>
  /** A pairing code from the host, used straight away. */
  pair(route: 'direct' | 'relay'): Promise<{ token: string; hostId: string; ms: number }>
  stop(): Promise<void>
}

/** Starts a relay, a host that dials it, and the proxies that give each leg a latency and a speed. */
export async function startLab(): Promise<Lab> {
  const external = process.env.RELAY_URL
  let relay: RunningRelay | undefined
  let relayTarget: { host: string; port: number }
  if (external) {
    const url = new URL(external)
    relayTarget = {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    }
  } else {
    relay = await startRelay({ port: 0, host: '127.0.0.1' })
    relayTarget = { host: '127.0.0.1', port: relay.port }
  }
  const hostToRelay = new LatencyProxy(relayTarget)
  const deviceToRelay = new LatencyProxy(relayTarget)
  const home = mkdtempSync(path.join(os.tmpdir(), 'beddcode-relay-home-'))
  const port = await freePort()
  const direct = new LatencyProxy({ host: '127.0.0.1', port })
  await Promise.all([hostToRelay.listen(), deviceToRelay.listen(), direct.listen()])

  const require = createRequire(path.join(root, 'apps/server/package.json'))
  const relayUrl = external ?? `http://127.0.0.1:${hostToRelay.port}`
  const child: ChildProcess = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(require.resolve('tsx')).href,
      path.join(root, 'apps/server/src/main.ts'),
      'serve',
    ],
    {
      cwd: home,
      stdio: 'ignore',
      env: {
        ...process.env,
        BEDDCODE_HOME: home,
        BEDDCODE_PORT: String(port),
        BEDDCODE_HOST: '127.0.0.1',
        BEDDCODE_FAKE_PROVIDER: 'advanced',
        BEDDCODE_WEB_ROOT: path.join(root, 'apps/web/dist'),
        BEDDCODE_TELEMETRY: '0',
        BEDDCODE_RELAY_URL: relayUrl,
        ...(process.env.RELAY_PASSWORD
          ? { BEDDCODE_RELAY_PASSWORD: process.env.RELAY_PASSWORD }
          : {}),
      },
    },
  )

  const wsUrl = `ws://127.0.0.1:${port}/ws`
  const newLocalClient = async () => {
    const host = new Host(wsUrl)
    await host.connect()
    return host
  }
  // Wait for the host to answer and for its relay agent to be online.
  const deadline = Date.now() + 60_000
  let bootHost: Host | undefined
  for (;;) {
    try {
      bootHost = await newLocalClient()
      const settings = await bootHost.rpc('host.relay.get', {})
      if (settings.status === 'online') break
    } catch {
      // not up yet
    }
    bootHost?.close()
    if (Date.now() > deadline) throw new Error('The host did not come online through the relay')
    await new Promise((r) => setTimeout(r, 500))
  }
  bootHost.close()

  const lab: Lab = {
    local: { port, wsUrl, home },
    proxies: { direct, deviceToRelay, hostToRelay },
    relayRoute: '',
    directUrl: `ws://127.0.0.1:${direct.port}/ws`,
    setProfile(profile) {
      const shape = { delayMs: profile.delayMs, kbps: profile.kbps }
      for (const proxy of [direct, deviceToRelay, hostToRelay]) proxy.configure(shape)
    },
    resetBytes() {
      for (const proxy of [direct, deviceToRelay, hostToRelay]) proxy.resetCounters()
    },
    newLocalClient,
    async pair(route) {
      const local = await newLocalClient()
      try {
        const pair = await local.rpc('host.pair', {})
        const link = parsePairLink(pair.link ?? '')
        const began = performance.now()
        if (route === 'direct') {
          const result = await pairWithHost(
            { host: '127.0.0.1', port: direct.port },
            pair.code,
            'bench',
          )
          return { token: result.token, hostId: result.host.hostId!, ms: performance.now() - began }
        }
        const relayRoute = link?.relay ?? link?.routes.find((r) => r.startsWith('relay+'))
        if (!relayRoute) throw new Error('The host gave no relay route in its pairing link')
        const result = await pairViaRelay(deviceRoute(relayRoute), pair.code, 'bench')
        return { token: result.token, hostId: result.host.hostId!, ms: performance.now() - began }
      } finally {
        local.close()
      }
    },
    async stop() {
      child.kill()
      await Promise.all([direct.close(), deviceToRelay.close(), hostToRelay.close()])
      await relay?.close()
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        // The host may still be closing its files; the folder is in the temp directory.
      }
    },
  }

  /** The device reaches the relay through its own leg instead of the host's. */
  function deviceRoute(route: string): string {
    if (external) return route
    const parsed = parseRelayRoute(route)
    if (!parsed) throw new Error('Not a relay route')
    const key = route.slice(route.lastIndexOf('#k=') + 3)
    return buildRelayRoute(`ws://127.0.0.1:${deviceToRelay.port}`, key)
  }
  // The route is only known once the host has made its key; ask for it once.
  const probe = await newLocalClient()
  const pair = await probe.rpc('host.pair', {})
  probe.close()
  const link = parsePairLink(pair.link ?? '')
  const route = link?.relay ?? link?.routes.find((r) => r.startsWith('relay+'))
  if (!route) throw new Error('The host did not offer a relay route; is the relay reachable?')
  lab.relayRoute = deviceRoute(route)
  return lab
}

export interface Synced {
  client: HostClient
  /** Milliseconds from `start()` until the host said the replay was complete. */
  syncMs: number
  events: number
  /** Called for every event that arrives after the replay. */
  stream?: (stored: any) => void
  /** Closes the underlying network connection, as a drop does (the client then reconnects). */
  cut(): void
  stop(): void
}

/** Connects a real HostClient and waits until it has caught up with the host's log. */
export async function sync(
  url: string,
  token: string,
  hostId: string,
  resume?: { seq: number; logId: string },
  extra: Partial<HostClientOptions> = {},
): Promise<Synced> {
  let events = 0
  let caught!: () => void
  const done = new Promise<void>((resolve) => (caught = resolve))
  const synced = {} as Synced
  const raw = new Set<WebSocket>()
  const open = (u: string) => {
    const ws = new WebSocket(u)
    raw.add(ws)
    return ws
  }
  const client = new HostClient({
    url,
    token,
    expectedHostId: hostId,
    createSocket: (u) =>
      (isRelayRoute(u) ? new RelaySocket(u, open) : open(u)) as unknown as WebSocket,
    ...extra,
    onEvent: (stored) => {
      events++
      synced.stream?.(stored)
    },
    onCaughtUp: () => caught(),
  })
  if (resume) client.restore(resume.seq, resume.logId)
  const began = performance.now()
  client.start()
  await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error('sync timed out')), 120_000)),
  ])
  return Object.assign(synced, {
    client,
    syncMs: performance.now() - began,
    events,
    stop: () => client.stop(),
    cut: () => raw.forEach((ws) => ws.close()),
  })
}

export const save = (dir: string, name: string, data: unknown) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2))
}
