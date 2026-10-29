import { readJsonFile, writeFileAtomic } from '@beddcode/shared'
import os from 'node:os'
import path from 'node:path'
import type { PairResult } from '@beddcode/contracts'
import { dataHome } from '../hostIdentity.ts'

/** A host the command line can talk to: this machine's, or a paired remote one. */
export interface HostTarget {
  name: string
  /** WebSocket addresses of the same host, tried in order. */
  urls: string[]
  token?: string
  hostId?: string
  /** This machine's own host: loopback needs no token. */
  local?: boolean
}

export const LOCAL_NAME = 'local'

export const localTarget = (port: number): HostTarget => ({
  name: LOCAL_NAME,
  urls: [`ws://127.0.0.1:${port}/ws`],
  local: true,
})

export const hostsFile = () => path.join(dataHome(), 'cli-hosts.json')

export function loadSaved(file = hostsFile()): HostTarget[] {
  const read = readJsonFile(file)
  return read.status === 'ok' && Array.isArray(read.value) ? (read.value as HostTarget[]) : []
}

export function saveHosts(hosts: HostTarget[], file = hostsFile()): void {
  // Holds access tokens for other machines, so only this user reads it.
  writeFileAtomic(file, JSON.stringify(hosts, null, 2), { mode: 0o600 })
}

/** `build-server`, `build-server:4000`, `http://build-server:3773` → the host's HTTP and WS bases. */
export function parseAddress(address: string): { http: string; ws: string } {
  const withScheme = /^[a-z]+:\/\//i.test(address) ? address : `http://${address}`
  const url = new URL(withScheme)
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const port = url.port || '3773'
  const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname
  return {
    http: `${secure ? 'https' : 'http'}://${host}:${port}`,
    ws: `${secure ? 'wss' : 'ws'}://${host}:${port}/ws`,
  }
}

/** Every host the command line knows: this machine first, then the paired ones. */
export function allTargets(port: number, saved = loadSaved()): HostTarget[] {
  return [localTarget(port), ...saved.filter((h) => h.name !== LOCAL_NAME)]
}

/** The hosts a command works with: the one named by `--host`, or all of them. */
export function pickTargets(all: HostTarget[], selector?: string): HostTarget[] {
  if (!selector) return all
  const wanted = selector.toLowerCase()
  const found = all.filter((h) => h.name.toLowerCase() === wanted)
  if (found.length === 0) {
    throw new Error(
      `No host named "${selector}". Known: ${all.map((h) => h.name).join(', ')} (add one with \`beddcode hosts add\`)`,
    )
  }
  return found
}

/** Pairs with a remote host using the code `beddcode pair` printed there, and saves it. */
export async function pairRemote(
  address: string,
  code: string,
  name: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<HostTarget> {
  const base = parseAddress(address)
  let res: Response
  try {
    res = await fetchFn(`${base.http}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: `beddcode CLI on ${os.hostname()}` }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    throw new Error(`Could not reach ${base.http} (${err instanceof Error ? err.message : err})`)
  }
  const body = (await res.json().catch(() => ({}))) as Partial<PairResult> & { error?: string }
  if (!res.ok || !body.token || !body.host) {
    throw new Error(body.error ?? `The host answered ${res.status}`)
  }
  return {
    name: name ?? body.host.name,
    urls: [base.ws],
    token: body.token,
    hostId: body.host.hostId,
  }
}

export function addHost(saved: HostTarget[], target: HostTarget): HostTarget[] {
  if (target.name === LOCAL_NAME) throw new Error(`"${LOCAL_NAME}" is this machine's own host`)
  return [...saved.filter((h) => h.name !== target.name && h.hostId !== target.hostId), target]
}
