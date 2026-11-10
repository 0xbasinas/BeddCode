import { create } from 'zustand'
import type { HostClient } from '@beddcode/client-runtime'
import { pullHostSettings, type LocalSharedSettings } from '@beddcode/client-runtime'
import type { SharedSettings, SharedSettingsPatch, SharedSettingsRecord } from '@beddcode/contracts'

import { defaultHandoffPolicy, setHandoffPush, useAutoHandoff } from './autoHandoff'

interface HostSettingsState {
  records: Record<string, SharedSettingsRecord>
  apply(hostKey: string, record: SharedSettingsRecord): void
}

const applying = new Set<string>()
const clients = new Map<string, Pick<HostClient, 'request'>>()

export const useHostSettings = create<HostSettingsState>((set) => ({
  records: {},
  apply(hostKey, record) {
    set((s) => ({ records: { ...s.records, [hostKey]: record } }))
  },
}))

function hydrateHandoff(hostKey: string, settings: SharedSettings) {
  applying.add(hostKey)
  try {
    useAutoHandoff.setState({
      hosts: {
        ...useAutoHandoff.getState().hosts,
        [hostKey]: {
          global: settings.handoff.global,
          projects: { ...settings.handoff.projects },
        },
      },
    })
  } finally {
    applying.delete(hostKey)
  }
}

export function applyHostSettingsRecord(hostKey: string, record: SharedSettingsRecord) {
  useHostSettings.getState().apply(hostKey, record)
  hydrateHandoff(hostKey, record.settings)
}

export function localSharedSettingsFor(hostKey: string): LocalSharedSettings {
  const handoff = useAutoHandoff.getState().hosts[hostKey]
  const current = useHostSettings.getState().records[hostKey]?.settings
  return {
    handoff: handoff ?? { global: defaultHandoffPolicy, projects: {} },
    defaultInstanceId: current?.defaultInstanceId,
    agentDefaults: current?.agentDefaults,
    autoReview: current?.autoReview,
    theme: current?.theme,
    defaultWorkspace: current?.defaultWorkspace,
    notifications: current?.notifications,
  }
}

export function bindHostSettingsClient(hostKey: string, client: Pick<HostClient, 'request'>) {
  clients.set(hostKey, client)
}

export function unbindHostSettingsClient(hostKey: string, client?: Pick<HostClient, 'request'>) {
  if (!client || clients.get(hostKey) === client) clients.delete(hostKey)
}

export async function pullAndApplyHostSettings(hostKey: string, client: Pick<HostClient, 'request'>) {
  bindHostSettingsClient(hostKey, client)
  const record = await pullHostSettings(
    () => client.request('settings.get', {}),
    (patch, baseVersion) => client.request('settings.update', { patch, baseVersion }),
    localSharedSettingsFor(hostKey),
  )
  if (clients.get(hostKey) !== client) return record
  applyHostSettingsRecord(hostKey, record)
  return record
}

export async function updateHostSettings(hostKey: string, patch: SharedSettingsPatch) {
  const client = clients.get(hostKey)
  if (!client) throw new Error('That host is not connected')
  const baseVersion = useHostSettings.getState().records[hostKey]?.version
  const record = await client.request('settings.update', { patch, baseVersion })
  applyHostSettingsRecord(hostKey, record)
  return record
}

function pushToHost(hostKey: string, patch: SharedSettingsPatch) {
  if (applying.has(hostKey) || !clients.has(hostKey)) return
  void updateHostSettings(hostKey, patch).catch(() => {
    // The next settings.changed or a later edit will refresh; the local store already has the choice.
  })
}

setHandoffPush((hostKey, patch) => pushToHost(hostKey, patch))
