import { describe, expect, it } from 'vitest'
import type { ProviderInstance } from '@beddcode/contracts'
import {
  agentDefaults,
  createPreferencesStore,
  defaultAgent,
  hostDefaults,
  loadPreferences,
} from './preferences.ts'

const provider: ProviderInstance = {
  id: 'test',
  kind: 'fake',
  label: 'Test',
  status: 'ready',
  capabilities: {
    resume: false,
    fork: false,
    steer: false,
    planMode: false,
    imageInput: false,
    usage: false,
    models: [{ id: 'small', label: 'Small' }],
    efforts: ['low'],
    permissionModes: [
      { id: 'ask', label: 'Ask' },
      { id: 'full', label: 'Full', dangerous: true },
    ],
  },
}

describe('new-session defaults', () => {
  it('persists separate defaults for each host and agent across reloads', () => {
    let value: string | null = null
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next
      },
    }
    const store = createPreferencesStore(storage)
    store.getState().setDefaultAgent('host-one', 'test')
    store.getState().setAgentDefaults('host-one', 'test', { model: 'small', permissionMode: 'ask' })
    store.getState().setAgentDefaults('host-one', 'other', { effort: 'high' })
    store.getState().setAgentDefaults('host-two', 'test', { permissionMode: 'full' })
    const reloaded = createPreferencesStore(storage).getState()
    expect(agentDefaults(hostDefaults(reloaded.hosts, 'host-one'), provider)).toEqual({
      model: 'small',
      permissionMode: 'ask',
      effort: undefined,
    })
    expect(agentDefaults(hostDefaults(reloaded.hosts, 'host-two'), provider).permissionMode).toBe(
      'full',
    )
    expect(hostDefaults(reloaded.hosts, 'host-one').agents.other?.effort).toBe('high')
    expect(hostDefaults(reloaded.hosts, 'host-two').instanceId).toBeUndefined()
  })

  it('falls back when a saved agent was removed or is no longer ready', () => {
    const offline = { ...provider, id: 'offline', status: 'not-installed' as const }
    expect(defaultAgent([offline, provider], 'offline')).toBe(provider)
    expect(defaultAgent([provider], 'removed')).toBe(provider)
    expect(defaultAgent([offline], 'offline')).toBeUndefined()
  })

  it('drops stale choices instead of passing unsupported options to a provider', () => {
    expect(
      agentDefaults(
        { agents: { test: { model: 'removed', effort: 'high', permissionMode: 'old' } } },
        provider,
      ),
    ).toEqual({ model: undefined, effort: undefined, permissionMode: undefined })
    expect(agentDefaults({ agents: {} }, undefined)).toEqual({})
  })

  it('resetting a choice removes it from the persisted defaults', () => {
    let value: string | null = null
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next
      },
    }
    const store = createPreferencesStore(storage)
    store.getState().setDefaultAgent('host', 'test')
    store.getState().setAgentDefaults('host', 'test', { model: 'small', effort: 'low' })
    store.getState().setAgentDefaults('host', 'test', { model: undefined })
    store.getState().setDefaultAgent('host', undefined)
    const saved = loadPreferences(storage).host!
    expect(saved.instanceId).toBeUndefined()
    expect(saved.agents.test?.model).toBeUndefined()
    expect(saved.agents.test?.effort).toBe('low')
  })

  it.each(['invalid JSON', 'null', '[]', '{"version":2,"hosts":{}}', '{"version":1,"hosts":[]}'])(
    'ignores invalid stored preferences: %s',
    (value) => {
      expect(loadPreferences({ getItem: () => value })).toEqual({})
    },
  )

  it('recovers valid fields from malformed records without trusting unexpected types', () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          version: 1,
          hosts: {
            bad: null,
            good: {
              instanceId: 4,
              agents: { invalid: [], test: { model: 'small', permissionMode: 3 } },
            },
          },
        }),
    }
    expect(loadPreferences(storage)).toEqual({
      good: {
        instanceId: undefined,
        agents: { test: { model: 'small', permissionMode: undefined, effort: undefined } },
      },
    })
    expect(hostDefaults({}, 'constructor')).toEqual({ agents: {} })
  })

  it('keeps working in memory when storage is blocked or full', () => {
    const store = createPreferencesStore({
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('full')
      },
    })
    store.getState().setDefaultAgent('host', 'test')
    expect(store.getState().hosts.host?.instanceId).toBe('test')
  })
})
