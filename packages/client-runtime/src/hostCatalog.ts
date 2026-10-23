import { PairResult, type TailnetPeer } from '@beddcode/contracts'

export const DEFAULT_PORT = 3773
export const LOCAL_HOST_KEY = 'local'

/** A host this app knows how to reach. */
export interface HostEntry {
  /** The host's own id (stable across address changes); `local` for the machine running the app. */
  key: string
  name: string
  /** WebSocket addresses of the same host, tried in order. */
  routes: string[]
  /** Proof of pairing; absent for the local host, which trusts this machine. */
  token?: string
}

export interface Address {
  host: string
  port: number
}

/**
 * Accepts what a person might type or paste: `build-server`, `build-server:4000`, `100.64.1.2`,
 * `[fd7a::1]:3773`, `http://build-server:3773`, `ws://100.64.1.2:3773/ws`.
 */
export function parseAddress(input: string): Address | null {
  let text = input.trim()
  if (!text) return null
  if (/^[a-z]+:\/\//i.test(text) && !/^(http|ws):\/\//i.test(text)) return null
  text = text.replace(/^(http|ws):\/\//i, '').replace(/[/?#].*$/, '')

  const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(text)
  const plain = /^([a-z0-9._-]+)(?::(\d+))?$/i.exec(text)
  const match = v6 ?? plain
  if (!match) return null
  const port = match[2] ? Number(match[2]) : DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  // Not `new URL(...)`: React Native's URL is incomplete, and a name only needs to be well formed.
  if (!v6 && /^[.-]|[.-]$|\.\./.test(match[1]!)) return null
  if (v6 && (/:::/.test(match[1]!) || (match[1]!.match(/::/g)?.length ?? 0) > 1)) return null
  return { host: match[1]!, port }
}

const hostPart = (a: Address) => (a.host.includes(':') ? `[${a.host}]` : a.host)
export const httpUrl = (a: Address, path = '') => `http://${hostPart(a)}:${a.port}${path}`
export const wsUrl = (a: Address) => `ws://${hostPart(a)}:${a.port}/ws`

/** Addresses to try for a Tailscale machine: its MagicDNS name first, then the raw IP. */
export function peerAddresses(peer: TailnetPeer, port = DEFAULT_PORT): Address[] {
  const list: Address[] = []
  if (peer.dnsName) list.push({ host: peer.dnsName, port })
  list.push({ host: peer.ip, port })
  return list
}

/** Exchanges a pairing code for a token. Throws a message fit to show the user. */
export async function pairWithHost(
  address: Address,
  code: string,
  deviceName: string,
  fetchFn: typeof fetch = fetch,
): Promise<PairResult> {
  let res: Response
  // `AbortSignal.timeout` is missing on some runtimes (React Native), so abort by hand.
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 5_000)
  try {
    res = await fetchFn(httpUrl(address, '/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), deviceName }),
      signal: abort.signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined
      throw new PairingError(
        typeof error === 'string' ? error : `The host refused the code (${res.status})`,
      )
    }
    const parsed = PairResult.safeParse(body)
    if (!parsed.success || !parsed.data.token || !parsed.data.host.hostId) {
      throw new PairingError('The host returned an invalid pairing response')
    }
    return parsed.data
  } catch (err) {
    if (err instanceof PairingError) throw err
    throw new Error(
      `Could not reach ${address.host}:${address.port}. Is the host running and on your tailnet?`,
    )
  } finally {
    clearTimeout(timer)
  }
}

class PairingError extends Error {}

const STORAGE_KEY = 'beddcode.hosts'

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Remote hosts saved earlier. Anything unreadable is ignored rather than breaking start-up. */
export function loadRemoteHosts(storage: KeyValueStorage | undefined): HostEntry[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return []
    return list.filter(
      (e): e is HostEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof e.key === 'string' &&
        e.key.length > 0 &&
        e.key !== LOCAL_HOST_KEY &&
        typeof e.name === 'string' &&
        Array.isArray(e.routes) &&
        e.routes.length > 0 &&
        e.routes.every((r: unknown) => {
          if (typeof r !== 'string') return false
          // A websocket address without credentials in it.
          return /^wss?:\/\/[^\s/@?#]+(\/[^\s]*)?$/i.test(r)
        }) &&
        typeof e.token === 'string' &&
        e.token.length > 0,
    )
  } catch {
    return []
  }
}

export function saveRemoteHosts(storage: KeyValueStorage | undefined, hosts: HostEntry[]) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(hosts.filter((h) => h.key !== LOCAL_HOST_KEY)))
  } catch {
    // Private mode or full storage: the host just will not be remembered.
  }
}

/** Adds a host, or replaces the one with the same key (re-pairing, a new address). */
export function upsertHost(hosts: HostEntry[], entry: HostEntry): HostEntry[] {
  return hosts.some((h) => h.key === entry.key)
    ? hosts.map((h) => (h.key === entry.key ? entry : h))
    : [...hosts, entry]
}
