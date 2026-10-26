import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { newRelayKey, roomFromKey, fromBase64Url } from '@beddcode/client-runtime/relayCrypto'

// Runs only against a deployed relay: RELAY_LIVE=wss://host pnpm vitest run src/live.test.ts
const live = process.env.RELAY_LIVE
describe.skipIf(!live)('deployed relay', () => {
  it('lets a host claim a room and turns a device away when the host leaves', async () => {
    const { room, auth } = roomFromKey(fromBase64Url(newRelayKey()))
    const hostPassword = process.env.RELAY_LIVE_PASSWORD
    const host = new WebSocket(
      `${live}/host/${room}`,
      hostPassword ? { headers: { authorization: `Bearer ${hostPassword}` } } : undefined,
    )
    await new Promise((r) => host.once('open', r))
    host.send(JSON.stringify({ t: 'host', auth }))
    const first = await new Promise<string>((r) => host.once('message', (m) => r(String(m))))
    expect(JSON.parse(first)).toEqual({ t: 'ready' })

    const device = new WebSocket(`${live}/client/${room}`)
    const opened = await new Promise<string>((r) => {
      device.once('open', () => r('open'))
      device.once('error', () => r('error'))
    })
    expect(opened).toBe('open')
    device.close()
    host.close()
    await new Promise((r) => setTimeout(r, 300))
    const late = new WebSocket(`${live}/client/${room}`)
    late.on('error', () => {})
    expect(await new Promise((r) => late.once('close', r))).toBeDefined()
  }, 30_000)
})

// Needs the relay's password too: RELAY_LIVE_PASSWORD=… (the Worker must have RELAY_PASSWORD set)
const password = process.env.RELAY_LIVE_PASSWORD
describe.skipIf(!live || !password)('deployed relay metrics', () => {
  const http = () => live!.replace(/^ws/, 'http')
  const auth = { authorization: `Bearer ${password}`, 'content-type': 'application/json' }
  const batch = (records: unknown[]) =>
    JSON.stringify({ host: 'livetest', platform: 'mobile', records })

  it('keeps valid measurements and refuses strangers and bad data', async () => {
    const good = [{ t: Date.now(), name: 'live.test.ms', value: 42, tags: { route: 'relay' } }]
    expect((await fetch(`${http()}/metrics`, { method: 'POST', body: batch(good) })).status).toBe(
      401,
    )
    const bad = [{ t: 1, name: 'x', value: 1, tags: { path: '/home/me/secret' } }]
    expect(
      (await fetch(`${http()}/metrics`, { method: 'POST', headers: auth, body: batch(bad) }))
        .status,
    ).toBe(400)
    expect(
      (await fetch(`${http()}/metrics`, { method: 'POST', headers: auth, body: batch(good) }))
        .status,
    ).toBe(204)
    const res = await fetch(`${http()}/metrics/summary?days=1`, { headers: auth })
    const summary = (await res.json()) as { rows: { name: string; route: string; count: number }[] }
    const row = summary.rows.find((r) => r.name === 'live.test.ms')
    expect(row).toMatchObject({ route: 'relay' })
    expect(row!.count).toBeGreaterThanOrEqual(1)
  })
})
