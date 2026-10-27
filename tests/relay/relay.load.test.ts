import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ConnectionState } from '../../packages/client-runtime/src/hostClient.ts'
import type { Host } from '../shared/hostClient.ts'
import { PROFILES, root, save, startLab, sync, type Lab, type Profile } from './harness.ts'

// How long a device waits for BeddCode over the relay, against reaching the host directly, on
// networks of different quality. The relay and the host run here; the proxies in harness.ts give
// each leg its delay and speed. Set RELAY_URL (and RELAY_PASSWORD) to use a deployed relay instead;
// the proxies then only shape the host's and the device's side of it.
const BULK = Number(process.env.RELAY_SESSIONS) || 120
const HEAVY_TURNS = Number(process.env.RELAY_HEAVY_TURNS) || 30
const ONLY = process.env.RELAY_PROFILES?.split(',')
// Against a deployed relay the network is the real one, so nothing is simulated: one run, no shaping.
const profiles: Profile[] = process.env.RELAY_URL
  ? [{ name: 'real', rtt: 0, delayMs: 0 }]
  : PROFILES.filter((p) => !ONLY || ONLY.includes(p.name))

let lab: Lab
let local: Host
const report: Record<string, any> = { startedAt: new Date().toISOString(), profiles: {} }

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0
const round = (n: number) => Math.round(n * 10) / 10

const create = (call: (method: string, params: object) => Promise<any>, title: string) =>
  call('sessions.create', {
    instanceId: 'fake',
    projectless: true,
    permissionMode: 'acceptEdits',
    title,
  })

async function turn(sessionId: string, text: string) {
  const from = local.events.length
  await local.rpc('sessions.prompt', { sessionId, text })
  await local.wait(
    () =>
      local.events
        .slice(from)
        .some(({ event }) => event.sessionId === sessionId && event.type === 'turn.completed'),
    120_000,
  )
}

beforeAll(async () => {
  lab = await startLab()
  local = await lab.newLocalClient()
  const run = crypto.randomUUID().slice(0, 6)
  const began = performance.now()
  const queue = Array.from({ length: BULK }, (_, i) => i + 1)
  await Promise.all([
    (async () => {
      const { sessionId } = await create(local.rpc.bind(local), `Big ${run}`)
      for (let n = 1; n <= HEAVY_TURNS; n++)
        await turn(sessionId, `${n % 5 === 0 ? '[heavy] ' : ''}Big turn ${n}`)
    })(),
    ...Array.from({ length: 15 }, async () => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        const { sessionId } = await create(local.rpc.bind(local), `Quick ${run} ${i}`)
        await turn(sessionId, `Quick task ${i}`)
      }
    }),
  ])
  report.history = {
    sessions: BULK + 1,
    heavyTurns: HEAVY_TURNS,
    events: local.events.length,
    setupMs: Math.round(performance.now() - began),
  }
}, 600_000)

afterAll(async () => {
  report.proxyCloses = {
    hostToRelay: lab?.proxies.hostToRelay.closes,
    deviceToRelay: lab?.proxies.deviceToRelay.closes,
  }
  local?.close()
  await lab?.stop()
  save(path.join(root, '.e2e', 'relay-stats'), `relay-${Date.now()}.json`, report)
}, 60_000)

async function measure(profile: Profile, route: 'direct' | 'relay') {
  const watch = watchRelay(profile.name + ':' + route)
  try {
    return await measureOnce(profile, route)
  } finally {
    watch()
  }
}

/** Notes every change of the host's relay status, to tell a dropped host leg from a dropped device leg. */
function watchRelay(label: string) {
  let last = ''
  const began = performance.now()
  const timer = setInterval(async () => {
    const status = await local.rpc('host.relay.get', {}).then((r) => r.status, () => 'unreachable')
    if (status !== last) {
      last = status
      ;(report.relayStatus ??= []).push({ label, atMs: Math.round(performance.now() - began), status })
    }
  }, 250)
  return () => clearInterval(timer)
}

async function measureOnce(profile: Profile, route: 'direct' | 'relay') {
  lab.setProfile(profile)
  const url = route === 'direct' ? lab.directUrl : lab.relayRoute
  const out: Record<string, any> = {}

  /** Bytes since the last call on each leg: up is toward the host, down toward the device. */
  const wire = () => {
    const legs: Record<string, { upKb: number; downKb: number }> = {}
    const proxies =
      route === 'direct'
        ? { device: lab.proxies.direct }
        : { device: lab.proxies.deviceToRelay, host: lab.proxies.hostToRelay }
    for (const [leg, proxy] of Object.entries(proxies))
      legs[leg] = { upKb: round(proxy.bytes.up / 1024), downKb: round(proxy.bytes.down / 1024) }
    lab.resetBytes()
    return legs
  }
  lab.resetBytes()
  const paired = await lab.pair(route)
  out.pairWire = wire()
  out.pairMs = Math.round(paired.ms)

  // A device that has never seen this host: the whole log comes down.
  const cold = await sync(url, paired.token, paired.hostId)
  const perf = (name: string) => cold.client.perf.recent.find((r) => r.name === name)?.value
  out.cold = {
    syncMs: Math.round(cold.syncMs),
    connectMs: perf('connect.ms'),
    replayMs: perf('replay.ms'),
    events: cold.events,
    replayKb: perf('replay.kb') && round(perf('replay.kb')!),
    wire: wire(),
  }

  // Small requests, one at a time: the cost of a round trip.
  const times: number[] = []
  for (let i = 0; i < 15; i++) {
    const began = performance.now()
    await cold.client.request('projects.list', {})
    times.push(performance.now() - began)
  }
  out.requestWire = wire()
  out.request = { medianMs: round(median(times)), p95Ms: round(p95(times)) }

  // A live answer: how late each streamed piece arrives, and how long until the first.
  const arrivals: number[] = []
  const lags: number[] = []
  let firstAt = 0
  const done = new Promise<void>((resolve) => {
    cold.stream = (stored) => {
      const e = stored.event
      if (e.type === 'message.delta' && e.role === 'assistant') {
        const t = Date.now()
        firstAt ||= t
        arrivals.push(t)
        lags.push(t - e.at)
      }
      if (e.type === 'turn.completed') resolve()
    }
  })
  const { sessionId } = (await create((m, p) => (cold.client.request as any)(m, p), `Live ${profile.name} ${route}`)) as any
  const sent = Date.now()
  await cold.client.request('sessions.prompt', { sessionId, text: '[stream:3] live check' })
  await done
  out.liveWire = wire()
  out.live = {
    firstDeltaMs: firstAt ? firstAt - sent : null,
    deltas: lags.length,
    lagMedianMs: round(median(lags)),
    lagP95Ms: round(p95(lags)),
  }

  // The same device coming back with what it already holds: nothing but the new part moves.
  const resume = { seq: cold.client.seq, logId: cold.client.log! }
  cold.stop()
  lab.resetBytes()
  wire()
  const warm = await sync(url, paired.token, paired.hostId, resume)
  out.warm = {
    syncMs: Math.round(warm.syncMs),
    events: warm.events,
    wire: wire(),
  }

  // A connected device doing nothing: heartbeats only (the client pings every 15 s).
  if (profile.name === 'lan') {
    wire()
    await new Promise((r) => setTimeout(r, 16_000))
    out.idle16sWire = wire()
  }

  // The link drops while connected: time until the device is back and caught up.
  const states: [number, ConnectionState][] = []
  const watched = await sync(url, paired.token, paired.hostId, undefined, {
    onState: (state) => states.push([performance.now(), state]),
  })
  const cut = performance.now()
  watched.cut()
  const back = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not reconnect')), 60_000)
    const poll = setInterval(() => {
      const again = states.find(([t, s]) => t > cut && s === 'connected')
      if (again) {
        clearTimeout(timer)
        clearInterval(poll)
        resolve(again[0] - cut)
      }
    }, 20)
  })
  out.reconnectMs = Math.round(back)
  watched.stop()
  warm.stop()
  return out
}

/** A measurement that lost its connection part-way is run once more, and the retry is recorded. */
async function attempt(profile: Profile, route: 'direct' | 'relay') {
  try {
    return await measure(profile, route)
  } catch (error) {
    ;(report.retries ??= []).push({ profile: profile.name, route, error: String(error) })
    return measure(profile, route)
  }
}

describe.each(profiles)('$name network (round trip $rtt ms per leg)', (profile) => {
  test('direct and over the relay', async () => {
    const direct = await attempt(profile, 'direct')
    const relayed = await attempt(profile, 'relay')
    const ratio = (a: number, b: number) => (b > 0 ? round(a / b) : null)
    report.profiles[profile.name] = {
      shape: { rtt: profile.rtt, delayMs: profile.delayMs, kbps: profile.kbps ?? null },
      direct,
      relay: relayed,
      relayVsDirect: {
        pair: ratio(relayed.pairMs, direct.pairMs),
        coldSync: ratio(relayed.cold.syncMs, direct.cold.syncMs),
        warmSync: ratio(relayed.warm.syncMs, direct.warm.syncMs),
        request: ratio(relayed.request.medianMs, direct.request.medianMs),
        reconnect: ratio(relayed.reconnectMs, direct.reconnectMs),
      },
    }
    // The same history arrives either way (the relayed run also sees the live session of the first).
    expect(relayed.cold.events).toBeGreaterThanOrEqual(direct.cold.events)
    expect(relayed.warm.events).toBeLessThan(relayed.cold.events / 10)
    expect(relayed.live.deltas).toBeGreaterThan(0)
  }, 300_000)
})
