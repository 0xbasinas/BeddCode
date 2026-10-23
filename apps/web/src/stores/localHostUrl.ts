/** Where the dev server's host listens; the Vite dev server has no host behind it. */
export const DEV_HOST_URL = 'ws://127.0.0.1:3773/ws'

/**
 * The WebSocket address of this computer's host:
 * - `override` (VITE_BEDDCODE_HOST_WS) wins, for trying another host,
 * - a built app served by the host itself (the desktop app, or a browser on the same machine or
 *   tailnet) talks back to the address it came from,
 * - otherwise the usual local one (the dev server, or the built app opened from disk).
 */
export function localHostUrl(options: {
  override?: string
  dev: boolean
  location?: { protocol: string; host: string }
}): string {
  if (options.override) return options.override
  const { location } = options
  if (
    !options.dev &&
    location &&
    (location.protocol === 'http:' || location.protocol === 'https:')
  ) {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  }
  return DEV_HOST_URL
}
