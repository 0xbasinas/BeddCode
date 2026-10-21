import { create } from 'zustand'

export interface AppPreferences {
  density: 'comfortable' | 'compact'
  uiFont: 'inter' | 'system'
  reduceMotion: boolean
  editorFontSize: number
  editorTabSize: 2 | 4
  editorWordWrap: boolean
  editorLineNumbers: boolean
  defaultHostKey: string
  defaultWorkspace: 'worktree' | 'local'
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  density: 'comfortable',
  uiFont: 'inter',
  reduceMotion: false,
  editorFontSize: 12,
  editorTabSize: 2,
  editorWordWrap: false,
  editorLineNumbers: true,
  defaultHostKey: 'local',
  defaultWorkspace: 'worktree',
}
const KEY = 'beddcode.app-preferences.v1'

export function parseAppPreferences(raw: string | null): AppPreferences {
  try {
    const saved: unknown = JSON.parse(raw ?? 'null')
    if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1)
      return DEFAULT_APP_PREFERENCES
    const value = saved as Record<string, unknown>
    return {
      density: value.density === 'compact' ? 'compact' : 'comfortable',
      uiFont: value.uiFont === 'system' ? 'system' : 'inter',
      reduceMotion: value.reduceMotion === true,
      editorFontSize:
        typeof value.editorFontSize === 'number' &&
        Number.isInteger(value.editorFontSize) &&
        value.editorFontSize >= 10 &&
        value.editorFontSize <= 20
          ? value.editorFontSize
          : 12,
      editorTabSize: value.editorTabSize === 4 ? 4 : 2,
      editorWordWrap: value.editorWordWrap === true,
      editorLineNumbers: value.editorLineNumbers !== false,
      defaultHostKey:
        typeof value.defaultHostKey === 'string' && value.defaultHostKey.length > 0
          ? value.defaultHostKey
          : 'local',
      defaultWorkspace: value.defaultWorkspace === 'local' ? 'local' : 'worktree',
    }
  } catch {
    return DEFAULT_APP_PREFERENCES
  }
}

function read() {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export const useAppPreferences = create<{
  values: AppPreferences
  update(patch: Partial<AppPreferences>): void
}>((set) => ({
  values: parseAppPreferences(read()),
  update: (patch) =>
    set((state) => {
      const values = { ...state.values, ...patch }
      try {
        localStorage.setItem(KEY, JSON.stringify({ version: 1, ...values }))
      } catch {
        /* Keep this window usable when storage is blocked. */
      }
      return { values }
    }),
}))
