import { PairResult } from '@beddcode/contracts'
import { pairWithHost, parseAddress, type HostEntry } from './hostCatalog.ts'
import { buildRelayRoute, pairViaRelay, parseRelayRoute } from './relaySocket.ts'

/**
 * Everything another device needs to pair with a host, in one link a QR code can carry:
 * `beddcode://pair?c=123456&n=Desk&h=<hostId>&r=ws://desk:3773/ws&r=ws://192.168.1.4:3773/ws`.
 * The routes are tried in order. `y` and `k` are the relay's address and the host's key (see
 * relaySocket.ts); they are two plain values because `+` and `#` do not survive every app that
 * opens a link.
 */
export interface PairLink {
  code: string
  name?: string
  hostId?: string
  routes: string[]
  relay?: string
}

const SCHEME = 'beddcode://pair'

/** The `y` and `k` values of a link for this relay route (what to hand a screen that opens it). */
export function relayLinkParams(route: string): { y: string; k: string } {
  const relay = parseRelayRoute(route)
  if (!relay) return { y: '', k: '' }
  return {
    y: relay.base.replace(/^wss:\/\//i, ''),
    k: route.slice(route.lastIndexOf('#k=') + 3),
  }
}

export function buildPairLink(link: PairLink): string {
  const parts = [`c=${encodeURIComponent(link.code)}`]
  if (link.name) parts.push(`n=${encodeURIComponent(link.name)}`)
  if (link.hostId) parts.push(`h=${encodeURIComponent(link.hostId)}`)
  for (const route of link.routes) parts.push(`r=${encodeURIComponent(route)}`)
  if (link.relay && parseRelayRoute(link.relay)) {
    const { y, k } = relayLinkParams(link.relay)
    parts.push(`y=${encodeURIComponent(y)}`, `k=${k}`)
  }
  return `${SCHEME}?${parts.join('&')}`
}

const WS_ROUTE = /^wss?:\/\/[^\s/@?#]+(\/[^\s]*)?$/i
/** A relay route carries the relay's address and the key; see relaySocket.ts. */
const isRelay = (route: string) => parseRelayRoute(route) !== null

/** Reads a pairing link a person pasted, or a scanner opened. Null for anything else. */
export function parsePairLink(input: string): PairLink | null {
  const text = input.trim()
  if (!text.toLowerCase().startsWith(SCHEME)) return null
  const query = text.slice(SCHEME.length).replace(/^\/?\?/, '')
  const link: PairLink = { code: '', routes: [] }
  let relayBase: string | undefined
  let relayKey: string | undefined
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    let value: string
    try {
      value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))
    } catch {
      return null
    }
    switch (pair.slice(0, eq)) {
      case 'c':
        link.code = value
        break
      case 'n':
        link.name = value
        break
      case 'h':
        link.hostId = value
        break
      case 'r':
        if (WS_ROUTE.test(value)) link.routes.push(value)
        break
      case 'y':
        // A full relay route (older links), or just the relay's address.
        if (isRelay(value)) link.relay = value
        else relayBase = /^wss?:\/\//i.test(value) ? value : `wss://${value}`
        break
      case 'k':
        relayKey = value
        break
    }
  }
  if (relayBase && relayKey) {
    const route = buildRelayRoute(relayBase, relayKey)
    if (isRelay(route)) link.relay = route
  }
  if (!/^\d{6}$/.test(link.code)) return null
  if (link.routes.length === 0 && !link.relay) return null
  return link
}

/**
 * Pairs using a link: tries each direct address in turn and returns the host entry to save, with
 * every route from the link so the app can fall back between them later.
 */
export async function pairWithLink(
  link: PairLink,
  deviceName: string,
  fetchFn: typeof fetch = fetch,
): Promise<HostEntry> {
  let lastError: Error | undefined
  for (const route of link.routes) {
    const address = parseAddress(route)
    if (!address) continue
    try {
      const result: PairResult = await pairWithHost(address, link.code, deviceName, fetchFn)
      if (link.hostId && result.host.hostId !== link.hostId) {
        throw new Error('That address answered as a different computer than the one in the link.')
      }
      return {
        key: result.host.hostId,
        name: result.host.name,
        routes: [...link.routes, ...(link.relay ? [link.relay] : [])],
        token: result.token,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // A wrong or used code will not be right on another address.
      if (!/Could not reach/.test(lastError.message)) throw lastError
    }
  }
  // No direct address answered: ask through the relay, which works from any network.
  if (link.relay) {
    const result = await pairViaRelay(link.relay, link.code, deviceName)
    if (link.hostId && result.host.hostId !== link.hostId) {
      throw new Error('The relay answered as a different computer than the one in the link.')
    }
    return {
      key: result.host.hostId,
      name: result.host.name,
      routes: [...link.routes, link.relay],
      token: result.token,
    }
  }
  throw (
    lastError ??
    new Error('This link has no address your device can reach. Try again on the same network.')
  )
}
