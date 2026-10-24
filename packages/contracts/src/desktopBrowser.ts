// The desktop app's browser pane: the app page (apps/web) asks the main process (apps/desktop) to
// show pages in native views and hears back what they do. Types only; it all stays on one computer.

/** A rectangle in the app page's CSS pixels. */
export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

/** What one tab's page reports about itself. Every field is optional in an update. */
export interface BrowserPageState {
  url: string
  title: string
  favicon?: string
  loading: boolean
  back: boolean
  forward: boolean
  /** The page's zoom factor (1 = 100%). */
  zoom: number
  /** The page's process died: why (crashed, killed, oom…). Cleared by reloading. */
  crashed?: string
  /** The page stopped responding (a busy loop); it may recover on its own. */
  unresponsive?: boolean
  /** The last load failed (DNS, refused, certificate…). Cleared by the next navigation. */
  error?: { code: number; description: string; url: string }
  /** The page was closed to save memory; it reloads from `url` when shown. */
  discarded?: boolean
  /** Errors in the console since the page loaded. */
  consoleErrors: number
  /** Find in page: the match shown and how many there are. */
  found?: { active: number; matches: number }
}

export interface BrowserConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error'
  message: string
  source?: string
  line?: number
  time: number
}

export type BrowserShortcutAction = 'find' | 'focus-address' | 'new-tab' | 'close-tab'

export type BrowserEvent =
  | { type: 'state'; tabId: number; state: Partial<BrowserPageState> }
  | { type: 'open'; url: string }
  | { type: 'shortcut'; tabId: number; action: BrowserShortcutAction }
  | {
      type: 'permission'
      id: string
      tabId?: number
      origin: string
      permission: string
      mediaTypes?: string[]
    }
  | { type: 'permission-done'; id: string }
  | { type: 'login'; id: string; tabId?: number; host: string; realm?: string; proxy: boolean }
  | { type: 'login-done'; id: string }
  | {
      type: 'download'
      id: string
      filename: string
      state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
      received: number
      total: number
    }

export type BrowserCommand =
  /** Creates the tab's page if it has none (new, or discarded) and loads `url` in it. */
  | { op: 'ensure'; tabId: number; url: string }
  | { op: 'navigate'; tabId: number; url: string }
  | { op: 'close'; tabId: number }
  /** Shows the active tab's page over `bounds` and hides every other; null hides them all. */
  | { op: 'layout'; tabId: number | null; bounds: BrowserRect | null; radius?: number }
  | {
      op: 'back' | 'forward' | 'reload' | 'hard-reload' | 'stop' | 'devtools' | 'focus'
      tabId: number
    }
  | { op: 'zoom'; tabId: number; direction: -1 | 0 | 1 }
  | { op: 'find'; tabId: number; text: string; forward?: boolean; next?: boolean }
  | { op: 'stop-find'; tabId: number }
  /** A PNG of the page (or a part of it), as a data URL. */
  | { op: 'capture'; tabId: number; rect?: BrowserRect }
  /** Saves the page as a PDF in the downloads folder; resolves to the file's name. */
  | { op: 'pdf'; tabId: number }
  | { op: 'exec'; tabId: number; code: string }
  | { op: 'console'; tabId: number }
  | { op: 'clear-console'; tabId: number }
  | { op: 'permission'; id: string; allow: boolean }
  | { op: 'login'; id: string; username?: string; password?: string }
  | { op: 'reveal-download'; id: string }
  | { op: 'open-external'; url: string }
  /** Forwards a port on a remote host here; resolves to the local port. */
  | { op: 'forward-port'; route: string; token?: string; port: number }
  /** Forgets cookies, storage and cache of every page in the pane. */
  | { op: 'clear-data' }
