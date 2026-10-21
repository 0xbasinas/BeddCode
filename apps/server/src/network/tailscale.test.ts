import { describe, expect, it } from 'vitest'
import type { RunResult } from '@beddcode/shared'
import { TailscaleService } from './tailscale.ts'

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })

const running = {
  BackendState: 'Running',
  Self: {
    HostName: 'basinakos',
    DNSName: 'basinakos.taild0277.ts.net.',
    TailscaleIPs: ['100.102.226.6', 'fd7a:115c:a1e0::e33a:e207'],
    Online: true,
    OS: 'windows',
  },
  Peer: {
    'nodekey:a': {
      HostName: 'build-server',
      DNSName: 'build-server.taild0277.ts.net.',
      TailscaleIPs: ['100.90.1.2', 'fd7a:115c:a1e0::1'],
      Online: true,
      OS: 'linux',
    },
    'nodekey:b': {
      HostName: 'studio-mac',
      DNSName: 'studio-mac.taild0277.ts.net.',
      TailscaleIPs: ['100.90.1.3'],
      Online: false,
      OS: 'macOS',
    },
    'nodekey:c': {
      HostName: 'phone',
      DNSName: 'phone.taild0277.ts.net.',
      TailscaleIPs: ['100.90.1.4'],
      Online: true,
      OS: 'iOS',
    },
    'nodekey:d': { HostName: 'v6-only', TailscaleIPs: ['fd7a:115c:a1e0::9'], Online: true },
  },
}

const service = (status: unknown, extra: ConstructorParameters<typeof TailscaleService>[0] = {}) =>
  new TailscaleService({ exe: 'tailscale', run: async () => ok(JSON.stringify(status)), ...extra })

describe('TailscaleService.status', () => {
  it('lists peers with their IPv4 address, online ones first', async () => {
    const status = await service(running).status()
    expect(status.state).toBe('running')
    expect(status.self).toEqual({
      name: 'basinakos',
      dnsName: 'basinakos.taild0277.ts.net',
      ip: '100.102.226.6',
    })
    expect(status.peers.map((p) => [p.name, p.ip, p.online])).toEqual([
      ['build-server', '100.90.1.2', true],
      ['phone', '100.90.1.4', true],
      ['studio-mac', '100.90.1.3', false],
    ])
    expect(status.peers[0]).toMatchObject({ dnsName: 'build-server.taild0277.ts.net', os: 'linux' })
  })

  it('explains a stopped Tailscale, a missing login and an unknown state', async () => {
    expect(await service({ BackendState: 'Stopped', Self: running.Self }).status()).toMatchObject({
      state: 'stopped',
      peers: [],
      self: { ip: '100.102.226.6' },
    })
    expect((await service({ BackendState: 'NoState' }).status()).state).toBe('stopped')
    expect((await service({ BackendState: 'NeedsLogin' }).status()).state).toBe('needs-login')
    expect(await service({ BackendState: 'Starting' }).status()).toMatchObject({
      state: 'error',
      message: 'Tailscale is Starting',
    })
  })

  it('reports a missing CLI, a failing CLI and garbage output', async () => {
    expect((await new TailscaleService({ exe: null }).status()).state).toBe('not-installed')

    const failing = new TailscaleService({
      exe: 'tailscale',
      run: async () => {
        throw new Error('spawn failed')
      },
    })
    expect(await failing.status()).toMatchObject({ state: 'error', message: 'spawn failed' })

    const garbage = new TailscaleService({
      exe: 'tailscale',
      run: async () => ({ code: 1, stdout: 'not json', stderr: 'daemon not running' }),
    })
    expect(await garbage.status()).toMatchObject({ state: 'error', message: 'daemon not running' })
  })
})

describe('TailscaleService.discover', () => {
  it('probes only online peers and marks the ones running BeddCode', async () => {
    const probed: string[] = []
    const discovered = await service(running, {
      probe: async (ip, port) => {
        probed.push(`${ip}:${port}`)
        return ip === '100.90.1.2' ? { hostId: 'host-1', name: 'build-server' } : null
      },
    }).discover(3773)

    expect(probed.sort()).toEqual(['100.90.1.2:3773', '100.90.1.4:3773'])
    expect(discovered.peers.find((p) => p.name === 'build-server')?.beddcode).toEqual({
      hostId: 'host-1',
      name: 'build-server',
      port: 3773,
    })
    expect(discovered.peers.find((p) => p.name === 'phone')?.beddcode).toBeUndefined()
    expect(discovered.peers.find((p) => p.name === 'studio-mac')?.beddcode).toBeUndefined()
  })

  it('treats a probe that throws as "not a host" and skips probing when Tailscale is off', async () => {
    const throwing = await service(running, {
      probe: async () => {
        throw new Error('boom')
      },
    }).discover(3773)
    expect(throwing.peers.every((p) => p.beddcode === undefined)).toBe(true)

    let probes = 0
    const off = await service(
      { BackendState: 'Stopped' },
      { probe: async () => (probes++, null) },
    ).discover(3773)
    expect(off.state).toBe('stopped')
    expect(probes).toBe(0)
  })
})
