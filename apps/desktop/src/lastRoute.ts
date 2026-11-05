/** Remembers which page of the app the window was on, so a restart of the app (a rebuilt main
 * process in development, an update) opens the same session instead of the start page. */

/** The in-app route of `url` (its `#/…` part) when it belongs to the app at `origin`. */
export function routeOf(url: string, origin: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== origin) return undefined
    return validRoute(parsed.hash)
  } catch {
    return undefined
  }
}

export function validRoute(value: unknown): string | undefined {
  return typeof value === 'string' && /^#\/[^\s]{0,498}$/.test(value) ? value : undefined
}

/** `url` opened at `route`, unless it already points somewhere in the app. */
export function withRoute(url: string, route: string | undefined): string {
  if (!route) return url
  try {
    const parsed = new URL(url)
    if (parsed.hash.length > 1) return url
    parsed.hash = route
    return parsed.toString()
  } catch {
    return url
  }
}
