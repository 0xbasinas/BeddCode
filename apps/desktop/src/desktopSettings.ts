import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserProfile } from '@beddcode/contracts'
import type { StoredBrowserExtension } from './browserExtensions.ts'
import { isHostMode, type HostMode } from './hostMode.ts'

/** Choices about the desktop app itself (the host's own settings live in its data folder). */
export interface DesktopSettings {
  /** Closing the window hides it to the tray instead of quitting. Unset means the platform default. */
  keepRunning?: boolean
  /** The "still running in the tray" notice has been shown once. */
  trayHintShown?: boolean
  /** Where the host comes from (see hostMode.ts). Unset means auto. */
  hostMode?: HostMode
  /** Per-project named browser profiles. Keys are opaque project identifiers from the app page. */
  browserProfiles?: Record<string, BrowserProfile[]>
  /** Active browser profile for each project key. */
  browserProfileDefaults?: Record<string, string>
  /** Preferred installed browser for opening links from each project. */
  browserDefaults?: Record<string, string>
  /** Unpacked extensions imported into each app-managed browser profile. */
  browserExtensions?: Record<string, StoredBrowserExtension[]>
}

export function readDesktopSettings(file: string): DesktopSettings {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const {
      keepRunning,
      trayHintShown,
      hostMode,
      browserProfiles,
      browserProfileDefaults,
      browserDefaults,
      browserExtensions,
    } = parsed as Record<string, unknown>
    return {
      ...(typeof keepRunning === 'boolean' && { keepRunning }),
      ...(typeof trayHintShown === 'boolean' && { trayHintShown }),
      ...(isHostMode(hostMode) && { hostMode }),
      ...(validProfiles(browserProfiles) && { browserProfiles }),
      ...(validDefaults(browserProfileDefaults) && { browserProfileDefaults }),
      ...(validBrowserDefaults(browserDefaults) && { browserDefaults }),
      ...(validExtensions(browserExtensions) && { browserExtensions }),
    }
  } catch {
    return {}
  }
}

function validProfiles(value: unknown): value is Record<string, BrowserProfile[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(
    (profiles) =>
      Array.isArray(profiles) &&
      profiles.every(
        (p) =>
          p &&
          typeof p === 'object' &&
          typeof p.id === 'string' &&
          /^[\w-]{1,80}$/.test(p.id) &&
          typeof p.name === 'string' &&
          p.name.length > 0 &&
          p.name.length <= 60 &&
          typeof p.agentsAllowed === 'boolean',
      ),
  )
}

function validDefaults(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((id) => typeof id === 'string' && /^[\w-]{1,80}$/.test(id))
}

function validBrowserDefaults(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((id) => typeof id === 'string' && /^[\w-]{1,40}$/.test(id))
}

function validExtensions(value: unknown): value is Record<string, StoredBrowserExtension[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(
    (extensions) =>
      Array.isArray(extensions) &&
      extensions.length <= 40 &&
      extensions.every(
        (extension) =>
          extension &&
          typeof extension === 'object' &&
          typeof extension.key === 'string' &&
          /^[\w-]{1,80}$/.test(extension.key) &&
          typeof extension.name === 'string' &&
          extension.name.length <= 100 &&
          typeof extension.path === 'string' &&
          path.isAbsolute(extension.path) &&
          typeof extension.electronId === 'string' &&
          /^[\w-]{1,80}$/.test(extension.electronId),
      ),
  )
}

export function writeDesktopSettings(file: string, settings: DesktopSettings): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}
