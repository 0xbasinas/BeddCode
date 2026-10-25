import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { newRelayKey, roomFromKey, fromBase64Url } from '@beddcode/client-runtime/relayCrypto'

// Runs only against a deployed relay: RELAY_LIVE=wss://host pnpm vitest run src/live.test.ts
const live = process.env.RELAY_LIVE
describe.skipIf(!live)('deployed relay', () => {
  it('lets a host claim a room and turns a device away when the host leaves', async () => {
    const { room, auth } = roomFromKey(fromBase64Url(newRelayKey()))
    const host = new WebSocket(`${live}/host/${room}`)
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
