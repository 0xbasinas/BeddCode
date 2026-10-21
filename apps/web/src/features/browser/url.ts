const SEARCH_URL = 'https://duckduckgo.com/?q='

/** Addresses that are almost certainly a local dev server or another machine on a private network. */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h === '::1' ||
    h.startsWith('127.') ||
    h === '0.0.0.0' ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    // Tailscale's CGNAT range and MagicDNS names.
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
    h.endsWith('.ts.net')
  )
}

/**
 * Turns what the user typed into a page address: a full http(s) URL is kept, `localhost:3000`
 * gets http, a bare domain gets https, and anything else becomes a web search. Other schemes
 * (javascript:, file:, data:) are refused.
 */
export function normalizeUrl(input: string): string | null {
  const text = input.trim()
  if (!text) return null

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)
  const looksLikeHostPort = /^[^\s/:]+:\d+(\/|$)/.test(text) || /^\[[0-9a-f:]+\]:\d+/i.test(text)
  if (scheme && !looksLikeHostPort) {
    return /^https?:$/i.test(`${scheme[1]}:`) && /^https?:\/\//i.test(text) ? text : null
  }

  const host = /^\[[^\]]+\]|^[^\s/:?#]+/.exec(text)?.[0]
  const hasSpace = /\s/.test(text)
  if (!hasSpace && host && (isLocalHost(host) || (host.includes('.') && !host.endsWith('.')))) {
    return `${isLocalHost(host) ? 'http' : 'https'}://${text}`
  }
  return `${SEARCH_URL}${encodeURIComponent(text)}`
}

/** A short label for a tab when the page has not told us its title. */
export function tabLabel(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname
    return `${u.host}${path}`
  } catch {
    return url
  }
}
