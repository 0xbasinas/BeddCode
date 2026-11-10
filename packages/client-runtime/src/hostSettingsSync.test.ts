import { describe, expect, it } from 'vitest'
import { emptySharedSettings, type SharedSettingsRecord } from '@beddcode/contracts'
import { hostSettingsAreUnset, migrationPatch, pullHostSettings } from './hostSettingsSync.ts'

const empty: SharedSettingsRecord = { version: 0, updatedAt: 0, settings: emptySharedSettings() }

describe('host settings sync helpers', () => {
  it('skips a migration when the leftover copy is still the defaults', () => {
    expect(migrationPatch({ handoff: emptySharedSettings().handoff, theme: undefined })).toBeNull()
  })

  it('uploads leftover agent, handoff, and theme values', () => {
    const patch = migrationPatch({
      defaultInstanceId: 'codex',
      agentDefaults: { codex: { model: 'gpt-5' } },
      handoff: {
        global: { mode: 'ask', fallback: ['claude'], maxHops: 3, cooldownMs: 1 },
        projects: {},
      },
      theme: 'light',
    })
    expect(patch?.defaultInstanceId).toBe('codex')
    expect(patch?.agentDefaults?.codex?.model).toBe('gpt-5')
    expect(patch?.handoff?.global?.mode).toBe('ask')
    expect(patch?.theme).toBe('light')
  })

  it('uploads local leftovers only when the host store is still empty', async () => {
    const calls: string[] = []
    const filled: SharedSettingsRecord = {
      version: 1,
      updatedAt: 10,
      settings: { ...emptySharedSettings(), theme: 'dark' },
    }
    const first = await pullHostSettings(
      async () => {
        calls.push('settings.get')
        return empty
      },
      async () => {
        calls.push('settings.update')
        return { version: 1, updatedAt: 2, settings: { ...emptySharedSettings(), theme: 'light' } }
      },
      { theme: 'light' },
    )
    expect(calls).toEqual(['settings.get', 'settings.update'])
    expect(first.settings.theme).toBe('light')
    calls.length = 0
    const second = await pullHostSettings(
      async () => {
        calls.push('settings.get')
        return filled
      },
      async () => {
        calls.push('settings.update')
        return filled
      },
      { theme: 'light' },
    )
    expect(calls).toEqual(['settings.get'])
    expect(second.settings.theme).toBe('dark')
  })

  it('treats version 0 as unset', () => {
    expect(hostSettingsAreUnset(empty)).toBe(true)
    expect(hostSettingsAreUnset({ ...empty, version: 1 })).toBe(false)
  })
})
