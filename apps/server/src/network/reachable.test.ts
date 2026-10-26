import { describe, expect, it } from 'vitest'
import type { TailscaleService } from './tailscale.ts'
import { lanAddresses, reachableRoutes } from './reachable.ts'

const tailscale = (state: string, self?: { name: string; dnsName: string; ip: string }) =>
  ({ status: async () => ({ state, self, peers: [] }) }) as unknown as TailscaleService

const nics = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  wifi: [
    { address: '192.168.1.4', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
  ],
  vpn: [{ address: '8.8.4.4', family: 'IPv4', internal: false }],
} as unknown as ReturnType<typeof import('node:os').networkInterfaces>

describe('reachableRoutes', () => {
  it('lists only private IPv4 addresses of real interfaces', () => {
    expect(lanAddresses(nics)).toEqual(['192.168.1.4'])
  })

  it('offers the tailnet name, then address, then the local network when allowed', async () => {
    const self = { name: 'desk', dnsName: 'desk.tail.ts.net', ip: '100.64.0.2' }
    const base = { tailscale: tailscale('running', self), port: 3773, interfaces: nics }
    expect(await reachableRoutes({ ...base, listenHost: '0.0.0.0', allowLan: true })).toEqual([
      'ws://desk.tail.ts.net:3773/ws',
      'ws://100.64.0.2:3773/ws',
      'ws://192.168.1.4:3773/ws',
    ])
    expect(await reachableRoutes({ ...base, listenHost: '0.0.0.0', allowLan: false })).toHaveLength(
      2,
    )
  })

  it('offers nothing for a host that only listens on this machine', async () => {
    expect(
      await reachableRoutes({
        tailscale: tailscale('running'),
        port: 1,
        listenHost: '127.0.0.1',
        allowLan: true,
        interfaces: nics,
      }),
    ).toEqual([])
  })
})
