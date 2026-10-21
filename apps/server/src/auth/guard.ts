import net from 'node:net'

/** Where a connection comes from, as far as trust is concerned. */
export type PeerClass = 'loopback' | 'tailnet' | 'lan' | 'other'

/** Strips the `::ffff:` prefix Node adds to IPv4 peers on dual-stack sockets. */
function unmap(address: string): string {
  return address.toLowerCase().replace(/^::ffff:/, '')
}

function ipv4Parts(address: string): number[] | null {
  if (net.isIPv4(address) === false) return null
  return address.split('.').map(Number)
}

/** Which kind of network a peer address belongs to. */
export function classifyPeer(rawAddress: string | undefined): PeerClass {
  if (!rawAddress) return 'other'
  const address = unmap(rawAddress)

  const v4 = ipv4Parts(address)
  if (v4) {
    const [a, b] = v4 as [number, number]
    if (a === 127) return 'loopback'
    // 100.64.0.0/10: Tailscale's carrier-grade NAT range.
    if (a === 100 && b >= 64 && b <= 127) return 'tailnet'
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan'
    if (a === 169 && b === 254) return 'lan'
    return 'other'
  }

  if (address === '::1') return 'loopback'
  // fd7a:115c:a1e0::/48: Tailscale's IPv6 range.
  if (address.startsWith('fd7a:115c:a1e0:')) return 'tailnet'
  if (address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:'))
    return 'lan'
  return 'other'
}

export interface GuardOptions {
  /** Require a paired device's token even from this machine (for hosts behind a proxy, and tests). */
  requireToken: boolean
  /** Also accept peers on ordinary private networks, not just the tailnet. Off by default. */
  allowLan: boolean
  /** Extra browser origins that may connect, besides pages served from this machine. */
  allowedOrigins: string[]
}

export const defaultGuard = (): GuardOptions => ({
  requireToken: false,
  allowLan: false,
  allowedOrigins: [],
})

/** Is this peer allowed to talk to the host at all? */
export function peerAllowed(peer: PeerClass, guard: GuardOptions): boolean {
  return peer === 'loopback' || peer === 'tailnet' || (peer === 'lan' && guard.allowLan)
}

/** Does this peer have to present a token? Only the machine itself is trusted without one. */
export function needsToken(peer: PeerClass, guard: GuardOptions): boolean {
  return guard.requireToken || peer !== 'loopback'
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

/**
 * Browsers let any web page open a WebSocket to localhost, so a page on the internet could
 * otherwise drive agents and shells. Browser requests must come from a page served by this
 * machine (or an origin the user listed). Requests without an Origin are not from a browser page.
 */
export function originAllowed(origin: string | undefined, guard: GuardOptions): boolean {
  if (origin === undefined) return true
  return LOCAL_ORIGIN.test(origin) || guard.allowedOrigins.includes(origin)
}
