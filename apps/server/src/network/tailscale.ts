import { existsSync } from 'node:fs'
import type { TailnetPeer, TailnetStatus } from '@beddcode/contracts'
import { resolveExecutable, runCommand, type RunResult } from '@beddcode/shared'

export interface ProbeResult {
  hostId: string
  name: string
}

export interface TailscaleOptions {
  /** Path to the `tailscale` CLI; found automatically when omitted. */
  exe?: string | null
  run?: (file: string, args: string[]) => Promise<RunResult>
  /** Asks a machine whether it runs a BeddCode host on `port`. */
  probe?: (ip: string, port: number) => Promise<ProbeResult | null>
}

interface RawNode {
  HostName?: string
  DNSName?: string
  TailscaleIPs?: string[]
  Online?: boolean
  OS?: string
}

interface RawStatus {
  BackendState?: string
  Self?: RawNode
  Peer?: Record<string, RawNode>
}

const defaultProbe = async (ip: string, port: number): Promise<ProbeResult | null> => {
  try {
    const res = await fetch(`http://${ip}:${port}/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean; host?: { hostId?: string; name?: string } }
    return body.ok && body.host?.hostId
      ? { hostId: body.host.hostId, name: body.host.name ?? '' }
      : null
  } catch {
    return null
  }
}

function findCli(): string | null {
  const found = resolveExecutable('tailscale')
  if (found) return found
  const known =
    process.platform === 'win32'
      ? 'C:\\Program Files\\Tailscale\\tailscale.exe'
      : process.platform === 'darwin'
        ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
        : null
  return known && existsSync(known) ? known : null
}

const firstIPv4 = (ips: string[] | undefined) => ips?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip))
const trimDot = (name: string | undefined) => (name ?? '').replace(/\.$/, '')

/**
 * What the user's own Tailscale knows: which machines are on the tailnet, and which of them
 * run a BeddCode host. It only reads status; it never starts, stops or configures Tailscale.
 */
export class TailscaleService {
  constructor(private readonly options: TailscaleOptions = {}) {}

  async status(): Promise<TailnetStatus> {
    const exe = this.options.exe === undefined ? findCli() : this.options.exe
    if (!exe) {
      return {
        state: 'not-installed',
        message: 'Tailscale is not installed on this machine',
        peers: [],
      }
    }

    let result: RunResult
    try {
      result = await (this.options.run ?? ((f, a) => runCommand(f, a, { timeoutMs: 8000 })))(exe, [
        'status',
        '--json',
      ])
    } catch (err) {
      return {
        state: 'error',
        message: err instanceof Error ? err.message : String(err),
        peers: [],
      }
    }

    let raw: RawStatus
    try {
      raw = JSON.parse(result.stdout) as RawStatus
    } catch {
      return {
        state: 'error',
        message: result.stderr.trim() || 'Tailscale did not return its status',
        peers: [],
      }
    }

    const selfIp = firstIPv4(raw.Self?.TailscaleIPs)
    const self =
      raw.Self && selfIp
        ? { name: raw.Self.HostName ?? '', dnsName: trimDot(raw.Self.DNSName), ip: selfIp }
        : undefined

    switch (raw.BackendState) {
      case 'Running':
        break
      case 'Stopped':
      case 'NoState':
        return { state: 'stopped', message: 'Tailscale is turned off', self, peers: [] }
      case 'NeedsLogin':
      case 'NeedsMachineAuth':
        return { state: 'needs-login', message: 'Sign in to Tailscale first', self, peers: [] }
      default:
        return {
          state: 'error',
          message: `Tailscale is ${raw.BackendState ?? 'in an unknown state'}`,
          self,
          peers: [],
        }
    }

    const peers: TailnetPeer[] = []
    for (const node of Object.values(raw.Peer ?? {})) {
      const ip = firstIPv4(node.TailscaleIPs)
      if (!ip) continue
      peers.push({
        name: node.HostName ?? ip,
        dnsName: trimDot(node.DNSName),
        ip,
        online: node.Online === true,
        os: node.OS ?? '',
      })
    }
    peers.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    return { state: 'running', self, peers }
  }

  /** Status plus a probe of every online peer for a BeddCode host on `port`. */
  async discover(port: number): Promise<TailnetStatus> {
    const status = await this.status()
    if (status.state !== 'running') return status
    const probe = this.options.probe ?? defaultProbe
    const peers = await Promise.all(
      status.peers.map(async (peer) => {
        if (!peer.online) return peer
        const found = await probe(peer.ip, port).catch(() => null)
        return found ? { ...peer, beddcode: { ...found, port } } : peer
      }),
    )
    return { ...status, peers }
  }
}
