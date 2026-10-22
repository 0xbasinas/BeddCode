declare global {
  interface Window {
    /** Present only inside the desktop app (see apps/desktop/src/preload.ts). */
    beddcodeDesktop?: {
      platform: string
      /** Opens the system's folder picker; null when the user cancels. */
      pickFolder?(options?: { defaultPath?: string }): Promise<string | null>
    }
  }
}

export const desktopBridge = () =>
  typeof window === 'undefined' ? undefined : window.beddcodeDesktop

/** True on macOS, where shortcuts use ⌘ instead of Ctrl. */
export const isMac = () =>
  desktopBridge()?.platform === 'darwin' ||
  (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform))
