import { describe, expect, it, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => {
  const mem = new Map<string, string>()
  return {
    default: {
      getItem: async (key: string) => mem.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        mem.set(key, value)
      },
      removeItem: async (key: string) => {
        mem.delete(key)
      },
    },
  }
})
import { emptySharedSettings, type SharedSettingsRecord } from '@beddcode/contracts'
import {
  applyHostSettingsRecord,
  bindHostSettingsClient,
  updateHostSettings,
  useHostSettings,
} from './hostSettings'
import { useAutoHandoff } from './autoHandoff'

describe('mobile host settings store', () => {
  it('hydrates handoff from a server record without a reload', () => {
    applyHostSettingsRecord('host-a', {
      version: 2,
      updatedAt: 10,
      settings: {
        ...emptySharedSettings(),
        theme: 'light',
        autoReview: 'ask',
        handoff: {
          global: { mode: 'auto', fallback: ['claude'], maxHops: 2, cooldownMs: 1 },
          projects: {
            '/repo': { mode: 'ask', fallback: ['codex'], maxHops: 1, cooldownMs: 1 },
          },
        },
      },
    })
    expect(useHostSettings.getState().records['host-a']?.settings.autoReview).toBe('ask')
    expect(useAutoHandoff.getState().hosts['host-a']?.global.mode).toBe('auto')
    expect(useAutoHandoff.getState().hosts['host-a']?.projects['/repo']?.mode).toBe('ask')
  })

  it('sends a patch with the current version and replaces the local copy with the host reply', async () => {
    applyHostSettingsRecord('host-b', {
      version: 3,
      updatedAt: 1,
      settings: { ...emptySharedSettings(), autoReview: 'off' },
    })
    const request = vi.fn(async () => {
      const record: SharedSettingsRecord = {
        version: 4,
        updatedAt: 2,
        settings: { ...emptySharedSettings(), autoReview: 'auto' },
      }
      return record
    })
    bindHostSettingsClient('host-b', { request: request as never })
    const result = await updateHostSettings('host-b', { autoReview: 'auto' })
    expect(request).toHaveBeenCalledWith('settings.update', {
      patch: { autoReview: 'auto' },
      baseVersion: 3,
    })
    expect(result.settings.autoReview).toBe('auto')
    expect(useHostSettings.getState().records['host-b']?.version).toBe(4)
  })
})
