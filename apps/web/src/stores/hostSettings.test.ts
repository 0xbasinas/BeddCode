import { describe, expect, it, vi } from 'vitest'
import { emptySharedSettings, type SharedSettingsRecord } from '@beddcode/contracts'
import {
  applyHostSettingsRecord,
  bindHostSettingsClient,
  updateHostSettings,
  useHostSettings,
} from './hostSettings.ts'
import { useAppPreferences } from './appPreferences.ts'
import { usePreferences } from './preferences.ts'
import { useAutoHandoff } from './autoHandoff.ts'

describe('host settings client store', () => {
  it('hydrates theme, agent defaults, and handoff from a server record without a reload', () => {
    applyHostSettingsRecord('host-a', {
      version: 2,
      updatedAt: 10,
      settings: {
        ...emptySharedSettings(),
        theme: 'light',
        defaultInstanceId: 'codex',
        agentDefaults: { codex: { model: 'gpt-5', permissionMode: 'ask' } },
        handoff: {
          global: { mode: 'auto', fallback: ['claude'], maxHops: 2, cooldownMs: 1 },
          projects: {},
        },
        notifications: { needsYou: false, turnDone: true, error: true, schedule: true },
      },
    })
    expect(useHostSettings.getState().records['host-a']?.version).toBe(2)
    expect(useAppPreferences.getState().values.theme).toBe('light')
    expect(usePreferences.getState().hosts['host-a']?.instanceId).toBe('codex')
    expect(usePreferences.getState().hosts['host-a']?.agents.codex?.model).toBe('gpt-5')
    expect(useAutoHandoff.getState().hosts['host-a']?.global.mode).toBe('auto')
  })

  it('sends a patch with the current version and replaces the local copy with the host reply', async () => {
    applyHostSettingsRecord('host-b', {
      version: 3,
      updatedAt: 1,
      settings: { ...emptySharedSettings(), theme: 'dark' },
    })
    const request = vi.fn(async () => {
      const record: SharedSettingsRecord = {
        version: 4,
        updatedAt: 2,
        settings: { ...emptySharedSettings(), theme: 'system' },
      }
      return record
    })
    bindHostSettingsClient('host-b', { request: request as never })
    const result = await updateHostSettings('host-b', { theme: 'system' })
    expect(request).toHaveBeenCalledWith('settings.update', { patch: { theme: 'system' }, baseVersion: 3 })
    expect(result.version).toBe(4)
    expect(useAppPreferences.getState().values.theme).toBe('system')
  })
})
