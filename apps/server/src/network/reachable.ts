import os from 'node:os'
import type { TailscaleService } from './tailscale.ts'

/** Private IPv4 addresses of this machine's network interfaces (home or office networks). */
export function lanAddresses(
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): string[] {
  const out: string[] = []
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.internal || info.family !== 'IPv4') continue
      const [a, b] = info.address.split('.').map(Number) as [number, number]
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
        out.push(info.address)
    }
  }
  return out
}

export interface ReachableOptions {
  tailscale: TailscaleService
  port: number
  /** The address the host listens on; a loopback-only host cannot be reached from anywhere else. */
  listenHost: string
  allowLan: boolean
  interfaces?: ReturnType<typeof os.networkInterfaces>
}

const url = (host: string, port: number) =>
  `ws://${host.includes(':') ? `[${host}]` : host}:${port}/ws`

/**
 * WebSocket addresses another device can use to reach this host, best first: the tailnet name
 * and address, then the local network when the host accepts it.
 */
export async function reachableRoutes(options: ReachableOptions): Promise<string[]> {
  const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(options.listenHost)
  if (loopbackOnly) return []
  const routes: string[] = []
  const tailnet = await options.tailscale.status().catch(() => undefined)
  if (tailnet?.state === 'running' && tailnet.self) {
    if (tailnet.self.dnsName) routes.push(url(tailnet.self.dnsName, options.port))
    routes.push(url(tailnet.self.ip, options.port))
  }
  if (options.allowLan) {
    for (const ip of lanAddresses(options.interfaces)) routes.push(url(ip, options.port))
  }
  return routes
}
