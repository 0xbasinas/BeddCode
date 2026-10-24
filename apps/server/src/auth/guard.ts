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

/** Headers a reverse proxy adds; a loopback peer carrying one is relaying someone else. */
const PROXY_HEADERS = [
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'x-forwarded-host',
  'x-forwarded-proto',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-headers-info',
  'tailscale-funnel-request',
  'cf-connecting-ip',
  'true-client-ip',
  'via',
]

type HeaderBag = Record<string, string | string[] | undefined>

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value.join(',') : value

/**
 * The client address a local proxy reports. The proxy appends (or sets) the address it saw last,
 * so the rightmost entry is the one to trust; anything left of it came from the client.
 */
export function forwardedAddress(headers: HeaderBag): string | undefined {
  const xff = first(headers['x-forwarded-for'])
  if (xff) {
    const last = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .at(-1)
    if (last) return stripPort(last)
  }
  const forwarded = first(headers.forwarded)
  if (forwarded) {
    const matches = [...forwarded.matchAll(/for=("?)([^;,"]+)\1/gi)]
    const last = matches.at(-1)?.[2]
    if (last) return stripPort(last)
  }
  const real = first(headers['x-real-ip'])?.trim()
  return real ? stripPort(real) : undefined
}

function stripPort(address: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address)
  if (bracketed) return bracketed[1]!
  // a.b.c.d:port; a bare IPv6 address has several colons and no port.
  const v4 = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(address)
  return v4 ? v4[1]! : address
}

/**
 * Where a request really comes from. A request from this machine that carries proxy headers was
 * relayed by a local reverse proxy (Tailscale Serve, nginx, a tunnel), so it is classified by the
 * address the proxy reports and never as this machine: otherwise everyone the proxy serves would
 * skip pairing. Tailscale Funnel traffic is from the internet. Headers from any other peer are
 * ignored, since only a local proxy's word means anything.
 */
export function classifyRequest(rawAddress: string | undefined, headers: HeaderBag): PeerClass {
  const direct = classifyPeer(rawAddress)
  if (direct !== 'loopback') return direct
  if (!PROXY_HEADERS.some((name) => headers[name] !== undefined)) return 'loopback'
  if (headers['tailscale-funnel-request'] !== undefined) return 'other'
  const address = forwardedAddress(headers)
  // Tailscale Serve always says who it relays; a tailnet identity without an address is still
  // a tailnet user.
  const relayed = address
    ? classifyPeer(address)
    : headers['tailscale-user-login'] !== undefined
      ? 'tailnet'
      : 'other'
  // A proxy relaying this machine to itself is still a proxy: no loopback trust through it.
  return relayed === 'loopback' ? 'other' : relayed
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
export function originAllowed(
  origin: string | undefined,
  guard: GuardOptions,
  host?: string,
): boolean {
  if (origin === undefined) return true
  return (
    LOCAL_ORIGIN.test(origin) ||
    guard.allowedOrigins.includes(origin) ||
    (host !== undefined && sameOriginAtAddress(origin, host))
  )
}

/**
 * Phone and desktop apps are not web pages, but their WebSocket stacks still send an Origin made
 * from the address they connected to (React Native does). A request whose Origin is the host it
 * addressed is allowed when that host is an IP address or a tailnet name. A web page cannot be
 * served from either (DNS rebinding needs a name the attacker controls), so this does not let a
 * page on the internet in.
 */
function sameOriginAtAddress(origin: string, hostHeader: string): boolean {
  const match = /^https?:\/\/([^/]+)$/i.exec(origin)
  if (!match || match[1]!.toLowerCase() !== hostHeader.toLowerCase()) return false
  const name = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return net.isIP(name) !== 0 || name.toLowerCase().endsWith('.ts.net')
}
