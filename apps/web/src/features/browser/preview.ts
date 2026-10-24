import { reachableUrl } from '@beddcode/client-runtime'
import { activeRoute, useHostStore } from '../../stores/host.ts'
import { browserCommand, nativeBrowser, type BrowserTab } from './browserStore.ts'

const LOOPBACK = /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/i

/** The port of an address on "this machine" (localhost, 127.x, [::1], 0.0.0.0); null otherwise. */
export function loopbackPort(url: string): number | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol) || !LOOPBACK.test(u.hostname)) return null
  return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
}

/** The same address on another local port (0.0.0.0, which browsers refuse, becomes localhost). */
export function withPort(url: string, port: number): string {
  const u = new URL(url)
  if (u.hostname === '0.0.0.0') u.hostname = 'localhost'
  u.port = String(port)
  return u.toString()
}

/** The machine a host route points at, or null when that is this device itself. */
export function remoteMachine(route: string | undefined): string | null {
  if (!route) return null
  try {
    const host = new URL(route.replace(/^ws/i, 'http')).hostname
    return LOOPBACK.test(host) ? null : host
  } catch {
    return null
  }
}

/**
 * Where to load a URL the user typed in the pane of a host. `localhost` means the host's machine,
 * which is not this device when the host is remote: the desktop app forwards the port here
 * through the host's connection; a plain browser can only try the host's own address (which
 * needs the dev server to listen beyond localhost).
 */
export async function previewTarget(
  hostKey: string,
  url: string,
): Promise<{ url: string; via?: BrowserTab['via'] }> {
  const port = loopbackPort(url)
  if (port === null) return { url }
  const entry = useHostStore.getState().entries.find((e) => e.key === hostKey)
  const route = activeRoute(hostKey) ?? entry?.routes[0]
  const machine = remoteMachine(route)
  if (!entry || !route || !machine) return { url }
  const via = { host: entry.name || machine, port }
  if (nativeBrowser()) {
    const local = await browserCommand<number>({
      op: 'forward-port',
      route,
      token: entry.token,
      port,
    })
    if (typeof local === 'number') return { url: withPort(url, local), via }
    throw new Error(`Could not forward port ${port} from ${via.host}`)
  }
  return { url: reachableUrl(url, route.replace(/^ws/i, 'http')), via }
}
