import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Choices about the desktop app itself (the host's own settings live in its data folder). */
export interface DesktopSettings {
  /** Closing the window hides it to the tray instead of quitting. Unset means the platform default. */
  keepRunning?: boolean
  /** The "still running in the tray" notice has been shown once. */
  trayHintShown?: boolean
}

export function readDesktopSettings(file: string): DesktopSettings {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const { keepRunning, trayHintShown } = parsed as Record<string, unknown>
    return {
      ...(typeof keepRunning === 'boolean' && { keepRunning }),
      ...(typeof trayHintShown === 'boolean' && { trayHintShown }),
    }
  } catch {
    return {}
  }
}

export function writeDesktopSettings(file: string, settings: DesktopSettings): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}
