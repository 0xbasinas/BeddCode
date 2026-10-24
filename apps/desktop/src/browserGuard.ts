// Pure rules for the browser pane's pages (see browserViews.ts for the Electron side). Kept free
// of Electron so they can be tested on their own.

/** The session the browser pane's pages run in: its own cookies and storage, kept across runs. */
export const BROWSER_PARTITION = 'persist:beddcode-browser'

/** Addresses a page may be shown at or navigate to: web pages only (no file:, javascript:, …). */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** Top-level navigations a page may make: web pages plus about:blank. */
export function navigationAllowed(url: string): boolean {
  return isWebUrl(url) || url === 'about:blank'
}

/** The address a page's window.open / target=_blank may open: web pages only. */
export function popupTarget(url: string): string | undefined {
  return isWebUrl(url) ? url : undefined
}

/**
 * Where a page's new window goes. Links (target=_blank) and bare window.open() get a tab in the
 * pane; window.open() with window features is usually a sign-in popup that talks back to its
 * opener (OAuth), so it gets a real window that keeps `window.opener`.
 */
export function popupDisposition(
  url: string,
  disposition: string,
  features: string,
): 'tab' | 'window' | 'deny' {
  if (!popupTarget(url)) return 'deny'
  return disposition === 'new-window' && features.trim() !== '' ? 'window' : 'tab'
}

/** Is this address on this machine (localhost, 127.x, ::1, *.localhost)? */
export function isLoopbackUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  host = host.replace(/^\[|\]$/g, '')
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  )
}

/** Granted without asking: harmless for a page being previewed. */
const ALWAYS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])
/** Asked in the pane, once per site and app run. Everything else is refused. */
const ASKABLE = new Set(['media', 'geolocation', 'notifications', 'clipboard-read', 'midi'])

export type PermissionVerdict = 'allow' | 'deny' | 'ask'

/** What to do with a page's permission request, given what the user already said for its site. */
export function permissionVerdict(permission: string, remembered?: boolean): PermissionVerdict {
  if (ALWAYS.has(permission)) return 'allow'
  if (!ASKABLE.has(permission)) return 'deny'
  if (remembered === undefined) return 'ask'
  return remembered ? 'allow' : 'deny'
}

/** The key a permission decision is remembered under: the site, the permission, the devices. */
export function permissionKey(origin: string, permission: string, mediaTypes?: string[]): string {
  const media = mediaTypes?.length ? `:${[...mediaTypes].sort().join('+')}` : ''
  return `${origin}|${permission}${media}`
}

/** What the old guard did, kept for callers that only need a yes or no. */
export interface GuardedSession {
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void
}

/** Refuses everything that would need the user's say; the pane's prompts replace this. */
export function guardBrowserSession(session: GuardedSession): void {
  session.setPermissionRequestHandler((_contents, permission, cb) =>
    cb(permissionVerdict(permission) === 'allow'),
  )
}

/** The keys of a keyboard event as Electron's before-input-event reports them. */
export interface KeyInput {
  type: string
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

export type BrowserShortcut =
  | 'find'
  | 'focus-address'
  | 'new-tab'
  | 'close-tab'
  | 'reload'
  | 'hard-reload'
  | 'back'
  | 'forward'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'devtools'

/**
 * The browser shortcuts a page in the pane should not swallow. Keys typed into a native view never
 * reach the app's page, so the view watches for these itself.
 */
export function shortcutFor(input: KeyInput, platform: string): BrowserShortcut | undefined {
  if (input.type !== 'keyDown') return undefined
  const mod = platform === 'darwin' ? input.meta : input.control
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key
  if (key === 'F5') return input.shift || mod ? 'hard-reload' : 'reload'
  if (key === 'F12') return 'devtools'
  if (mod && input.shift && key === 'i') return 'devtools'
  if (platform === 'darwin' && input.meta && input.alt && key === 'i') return 'devtools'
  if (!mod && input.alt && !input.shift) {
    if (key === 'ArrowLeft') return 'back'
    if (key === 'ArrowRight') return 'forward'
  }
  if (!mod) return undefined
  switch (key) {
    case 'f':
      return 'find'
    case 'l':
      return 'focus-address'
    case 't':
      return 'new-tab'
    case 'w':
      return 'close-tab'
    case 'r':
      return input.shift ? 'hard-reload' : 'reload'
    case '=':
    case '+':
      return 'zoom-in'
    case '-':
      return 'zoom-out'
    case '0':
      return 'zoom-reset'
    case '[':
      return platform === 'darwin' ? 'back' : undefined
    case ']':
      return platform === 'darwin' ? 'forward' : undefined
    default:
      return undefined
  }
}

/** Chromium's zoom levels, as steps of 20% around 100%. */
export const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
]

/** The next zoom factor in a direction (0 resets). */
export function nextZoom(current: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return 1
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS.at(-1)!
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0]!
}

/** A pane rectangle in the app page's CSS pixels, as the renderer measured it. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The rectangle for the native view, in window pixels: the page's CSS pixels times the app page's
 * own zoom, rounded so the view's edges land on the pane's. Null when there is nothing to show.
 */
export function viewBounds(rect: Rect | null | undefined, appZoom: number): Rect | null {
  if (!rect) return null
  const values = [rect.x, rect.y, rect.width, rect.height]
  if (!values.every(Number.isFinite)) return null
  const x = Math.round(rect.x * appZoom)
  const y = Math.round(rect.y * appZoom)
  const width = Math.round((rect.x + rect.width) * appZoom) - x
  const height = Math.round((rect.y + rect.height) * appZoom) - y
  if (width < 1 || height < 1) return null
  return { x: Math.max(0, x), y: Math.max(0, y), width, height }
}

/** A file name a download may be saved under: no folders, no characters Windows refuses. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned.slice(0, 200) || 'download'
}

/** `name.ext`, then `name (1).ext`, `name (2).ext`… whichever does not exist yet. */
export function uniqueFileName(name: string, exists: (candidate: string) => boolean): string {
  const safe = safeFileName(name)
  if (!exists(safe)) return safe
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

/** One message from a page's console. */
export interface ConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error'
  message: string
  source?: string
  line?: number
  time: number
}

/** The last messages of a page's console, oldest first; older ones fall off. */
export class ConsoleLog {
  private entries: ConsoleEntry[] = []
  errors = 0
  constructor(private readonly limit = 300) {}
  push(entry: ConsoleEntry): void {
    this.entries.push(entry)
    if (entry.level === 'error') this.errors++
    if (this.entries.length > this.limit) {
      const dropped = this.entries.shift()
      if (dropped?.level === 'error') this.errors--
    }
  }
  list(): ConsoleEntry[] {
    return this.entries.slice()
  }
  clear(): void {
    this.entries = []
    this.errors = 0
  }
}

/** A background tab can be discarded (its page closed, its address kept) to free memory. */
export interface DiscardCandidate {
  id: number
  visible: boolean
  lastShown: number
  /** Playing sound, devtools open, a prompt pending: worth keeping. */
  busy: boolean
}

/**
 * Which pages to close: hidden ones unused for `idleMs`, then, past `maxLive` live pages, the least
 * recently shown hidden ones.
 */
export function pagesToDiscard(
  pages: DiscardCandidate[],
  now: number,
  options: { idleMs: number; maxLive: number },
): number[] {
  const idle = pages.filter((p) => !p.visible && !p.busy)
  const out = new Set(idle.filter((p) => now - p.lastShown >= options.idleMs).map((p) => p.id))
  const excess = pages.length - out.size - options.maxLive
  if (excess > 0) {
    idle
      .filter((p) => !out.has(p.id))
      .sort((a, b) => a.lastShown - b.lastShown)
      .slice(0, excess)
      .forEach((p) => out.add(p.id))
  }
  return [...out]
}
