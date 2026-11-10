/**
 * Finds the preview URLs a dev server prints, so the app can offer "Open preview" without the
 * user copying a port out of terminal scrollback. Only loopback URLs are kept: anything else is
 * not this machine's preview.
 */

/** At most this many previews per terminal, newest kept. */
export const MAX_PREVIEWS = 10

// Full URLs: http(s)://localhost:3000/app, http://127.0.0.1:5173, http://[::1]:8080/…
const URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::\d{1,5})?(?:\/[^\s"'<>)]*)?/gi
// Bare host:port, the way vite/next print "Local: http://localhost:5173" sometimes without the scheme.
const BARE_RE = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d{2,5})\b/g

/** Ports that are almost never a dev server (ssh, smtp, …) and only add noise. */
const BORING_PORTS = new Set(['22', '25', '53', '80', '443', '143', '993', '587'])

/** Normalizes a match to a URL the browser pane can open. */
function normalize(raw: string, port?: string): string | null {
  if (raw.startsWith('http')) {
    try {
      const url = new URL(raw)
      if (
        !['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(
          url.hostname.toLowerCase(),
        ) &&
        !url.hostname.toLowerCase().endsWith('.localhost')
      )
        return null
      if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname === '[::1]')
        url.hostname = 'localhost'
      if (BORING_PORTS.has(url.port)) return null
      return url.toString().replace(/\/$/, '') || url.toString()
    } catch {
      return null
    }
  }
  if (!port || BORING_PORTS.has(port)) return null
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null
  return `http://localhost:${n}`
}

/**
 * The preview URLs in a chunk of terminal output. `tail` is the end of the output before this
 * chunk, so a URL split across two writes is still found.
 */
export function detectPreviewUrls(chunk: string, tail = ''): string[] {
  const text = tail + chunk
  const found = new Set<string>()
  for (const m of text.matchAll(URL_RE)) {
    const url = normalize(m[0])
    if (url) found.add(url)
  }
  for (const m of text.matchAll(BARE_RE)) {
    const url = normalize('', m[1])
    if (url) found.add(url)
  }
  return [...found]
}

/** Adds newly found URLs to the terminal's list (found ones first), capped at {@link MAX_PREVIEWS}. */
export function mergePreviews(existing: string[] | undefined, found: string[]): string[] {
  const next = [...found, ...(existing ?? [])]
  return [...new Set(next)].slice(0, MAX_PREVIEWS)
}
