/** The session the browser pane's pages run in (see createElementIn in BrowserPane.tsx). */
export const BROWSER_PARTITION = 'persist:beddcode-browser'

/** What the guard needs from an Electron session. */
export interface GuardedSession {
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void
}

// Asked by pages that are only being previewed; nothing here should reach the user's machine.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

/** Keeps pages in the browser pane from prompting for notifications, camera, location… */
export function guardBrowserSession(session: GuardedSession): void {
  session.setPermissionRequestHandler((_contents, permission, cb) =>
    cb(ALLOWED_PERMISSIONS.has(permission)),
  )
}

/** The address a page's window.open / target=_blank may open: web pages only. */
export function popupTarget(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined
}
