import type { BrowserCommand, BrowserEvent } from '@beddcode/contracts'

/** Window actions over IPC; each resolves to whether the window is now maximized. */
export interface DesktopWindow {
  minimize(): Promise<boolean>
  toggleMaximize(): Promise<boolean>
  close(): Promise<boolean>
  isMaximized(): Promise<boolean>
  /** Calls back whenever the window is maximized or restored; returns an unsubscribe. */
  onMaximizedChange(callback: (maximized: boolean) => void): () => void
}

/** The local host as the desktop app supervises it (apps/desktop/src/daemon.ts). */
export interface DesktopDaemonState {
  status: 'starting' | 'running' | 'attached' | 'restarting' | 'failed' | 'stopped'
  detail?: string
  restarts: number
  logFile?: string
}

export interface DesktopDaemon {
  status(): Promise<DesktopDaemonState | null>
  /** Replaces the host the app started, or starts a new one after a failure. False: not ours to restart. */
  restart(): Promise<boolean>
  log(): Promise<string>
  revealLog(): Promise<boolean>
  onStatus(callback: (state: DesktopDaemonState) => void): () => void
}

/** The browser pane's native pages (apps/desktop/src/browserViews.ts). */
export interface DesktopBrowser {
  command(command: BrowserCommand): Promise<unknown>
  /** Everything the pages report; returns an unsubscribe. */
  onEvent(callback: (event: BrowserEvent) => void): () => void
  /** Pages asking for a new window; returns an unsubscribe. */
  onOpen(callback: (url: string) => void): () => void
}

declare global {
  interface Window {
    /** Present only inside the desktop app (see apps/desktop/src/preload.ts). */
    beddcodeDesktop?: {
      platform: string
      /** Opens the system's folder picker; null when the user cancels. */
      pickFolder?(options?: { defaultPath?: string }): Promise<string | null>
      /** Tells the window which theme the page draws, so what shows behind it matches. */
      setTheme?(theme: 'light' | 'dark'): Promise<boolean>
      /** The app's own window buttons; absent on macOS builds that keep the traffic lights. */
      window?: DesktopWindow
      /** The browser pane's pages, native views the desktop app lays over the pane. */
      browser?: DesktopBrowser
      /** Supervision of the local host; absent in the browser. */
      daemon?: DesktopDaemon
    }
  }
}

export const desktopBridge = () =>
  typeof window === 'undefined' ? undefined : window.beddcodeDesktop

/** True on macOS, where shortcuts use ⌘ instead of Ctrl. */
export const isMac = () =>
  desktopBridge()?.platform === 'darwin' ||
  (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform))

/** The window controls the app draws itself: inside the desktop app, except on macOS. */
export const appWindowControls = (): DesktopWindow | undefined => {
  const bridge = desktopBridge()
  return bridge && bridge.platform !== 'darwin' ? bridge.window : undefined
}
