import { create } from 'zustand'
import type { ProviderInstance } from '@beddcode/contracts'
import { modelChoice } from '../ui/models.ts'

export interface AgentDefaults {
  model?: string
  effort?: string
  permissionMode?: string
}

export interface HostDefaults {
  instanceId?: string
  agents: Record<string, AgentDefaults>
}

const STORAGE_KEY = 'beddcode.preferences.v1'
const EMPTY: HostDefaults = { agents: {} }
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const optionalString = (value: unknown) =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export function loadPreferences(storage?: Pick<Storage, 'getItem'>): Record<string, HostDefaults> {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')
    if (!object(saved) || saved.version !== 1 || !object(saved.hosts)) return {}
    return Object.fromEntries(
      Object.entries(saved.hosts).flatMap(([key, value]) => {
        if (!object(value)) return []
        const agents = object(value.agents)
          ? Object.fromEntries(
              Object.entries(value.agents).flatMap(([id, defaults]) =>
                object(defaults)
                  ? [
                      [
                        id,
                        {
                          model: optionalString(defaults.model),
                          effort: optionalString(defaults.effort),
                          permissionMode: optionalString(defaults.permissionMode),
                        },
                      ],
                    ]
                  : [],
              ),
            )
          : {}
        return [[key, { instanceId: optionalString(value.instanceId), agents }]]
      }),
    )
  } catch {
    return {}
  }
}

export function hostDefaults(hosts: Record<string, HostDefaults>, hostId: string): HostDefaults {
  return Object.hasOwn(hosts, hostId) ? hosts[hostId]! : EMPTY
}

/** Ignore removed agents and choices that this host's current provider no longer supports. */
export function defaultAgent(providers: ProviderInstance[], instanceId?: string) {
  const ready = providers.filter((p) => p.status === 'ready')
  return ready.find((p) => p.id === instanceId) ?? ready[0]
}

export function agentDefaults(defaults: HostDefaults, agent?: ProviderInstance): AgentDefaults {
  if (!agent) return {}
  const saved = Object.hasOwn(defaults.agents, agent.id) ? defaults.agents[agent.id] : undefined
  return {
    ...modelChoice(agent.capabilities.models ?? [], agent.capabilities.efforts ?? [], saved ?? {}),
    permissionMode: agent.capabilities.permissionModes.some((m) => m.id === saved?.permissionMode)
      ? saved?.permissionMode
      : undefined,
  }
}

interface PreferencesState {
  hosts: Record<string, HostDefaults>
  setDefaultAgent(hostId: string, instanceId: string | undefined): void
  setAgentDefaults(hostId: string, instanceId: string, patch: Partial<AgentDefaults>): void
}

export function createPreferencesStore(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  return create<PreferencesState>((set) => {
    const update = (hostId: string, fn: (current: HostDefaults) => HostDefaults) =>
      set((s) => {
        const hosts = { ...s.hosts, [hostId]: fn(hostDefaults(s.hosts, hostId)) }
        try {
          storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, hosts }))
        } catch {
          // Preferences remain usable for this window when browser storage is unavailable.
        }
        return { hosts }
      })
    return {
      hosts: loadPreferences(storage),
      setDefaultAgent: (hostId, instanceId) => update(hostId, (d) => ({ ...d, instanceId })),
      setAgentDefaults: (hostId, id, patch) =>
        update(hostId, (d) => ({
          ...d,
          agents: {
            ...d.agents,
            [id]: { ...(Object.hasOwn(d.agents, id) ? d.agents[id] : {}), ...patch },
          },
        })),
    }
  })
}

function browserStorage() {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export const usePreferences = createPreferencesStore(browserStorage())
