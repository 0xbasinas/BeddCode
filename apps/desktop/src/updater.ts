/** What decides whether the app looks for updates by itself. */
export interface UpdateContext {
  /** Running from an installed build (not from the source tree). */
  packaged: boolean
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
}

/**
 * Installed Windows builds and Linux AppImages update themselves from GitHub releases. A .deb is
 * updated by the system's package manager, and a build run from source has nothing to update.
 * `BEDDCODE_NO_UPDATE=1` turns it off.
 */
export function shouldAutoUpdate({ packaged, platform, env }: UpdateContext): boolean {
  if (!packaged || env.BEDDCODE_NO_UPDATE === '1') return false
  if (platform === 'win32') return true
  if (platform === 'linux') return Boolean(env.APPIMAGE)
  return false
}

/** How long between checks while the app stays open. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdatesAndNotify(): Promise<unknown>
  on(event: 'error', listener: (err: Error) => void): unknown
}

/**
 * Checks for an update now and every few hours, downloads it in the background and installs it
 * when the app next quits. A failed check (offline, no release yet) is only logged. Returns the
 * function that stops checking.
 */
export function startAutoUpdate(
  updater: UpdaterLike,
  log: (message: string) => void = () => {},
  schedule: typeof setInterval = setInterval,
): () => void {
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.on('error', (err) => log(`update check failed: ${err.message}`))
  const check = () => {
    updater.checkForUpdatesAndNotify().catch((err: unknown) => {
      log(`update check failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  check()
  const timer = schedule(check, UPDATE_CHECK_INTERVAL_MS)
  return () => clearInterval(timer)
}
