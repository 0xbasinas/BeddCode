import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_PREFERENCES, parseAppPreferences } from './appPreferences.ts'

describe('app preferences', () => {
  it.each([null, 'broken', 'null', '[]', '{"version":2}'])(
    'recovers defaults from invalid or unsupported storage',
    (raw) => {
      expect(parseAppPreferences(raw)).toEqual(DEFAULT_APP_PREFERENCES)
    },
  )

  it('restores valid choices for the editor, interface and new sessions', () => {
    const values = {
      ...DEFAULT_APP_PREFERENCES,
      density: 'compact',
      uiFont: 'system',
      editorFontSize: 16,
      editorTabSize: 4,
      editorWordWrap: true,
      editorLineNumbers: false,
      defaultHostKey: 'remote-one',
      defaultWorkspace: 'local',
      reduceMotion: true,
    }
    expect(parseAppPreferences(JSON.stringify({ version: 1, ...values }))).toEqual(values)
  })

  it('rejects invalid sizes, enum values and non-boolean toggles', () => {
    expect(
      parseAppPreferences(
        JSON.stringify({
          version: 1,
          editorFontSize: 100,
          editorTabSize: 3,
          defaultHostKey: '',
          uiFont: 'unknown',
          density: 'spacious',
          reduceMotion: 'true',
          editorWordWrap: 1,
          editorLineNumbers: 'false',
          defaultWorkspace: 'invalid',
        }),
      ),
    ).toEqual(DEFAULT_APP_PREFERENCES)
  })
})
