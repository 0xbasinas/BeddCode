import { create } from 'zustand'
import type { SharedSettings, SharedSettingsPatch, SharedSettingsRecord } from '@beddcode/contracts'
import { pullHostSettings, type LocalSharedSettings } from '@beddcode/client-runtime'
import type { HostClient } from '@beddcode/client-runtime'
import { setPreferencesPush, usePreferences } from './preferences.ts'
import { defaultHandoffPolicy, setHandoffPush, useAutoHandoff } from './autoHandoff.ts'
import { setAppPreferencesPush, useAppPreferences } from './appPreferences.ts'
import { setNotificationPrefsPush, useNotificationPrefs } from './notificationPrefs.ts'

interface HostSettingsState {
  records: Record<string, SharedSettingsRecord>
  apply(hostKey: string, record: SharedSettingsRecord): void
}

/** Hosts we are currently applying a server copy onto, so we do not echo the write back. */
const applying = new Set<string>()

export const useHostSettings = create<HostSettingsState>((set) => ({
  records: {},
  apply(hostKey, record) {
    set((s) => ({ records: { ...s.records, [hostKey]: record } }))
  },
}))

function hydrateLocalStores(hostKey: string, settings: SharedSettings) {
  applying.add(hostKey)
  try {
    const current = usePreferences.getState().hosts[hostKey] ?? { agents: {} }
    usePreferences.setState({
      hosts: {
        ...usePreferences.getState().hosts,
        [hostKey]: {
          instanceId: settings.defaultInstanceId ?? current.instanceId,
          agents: { ...current.agents, ...settings.agentDefaults },
        },
      },
    })
    useAutoHandoff.setState({
      hosts: {
        ...useAutoHandoff.getState().hosts,
        [hostKey]: {
          global: settings.handoff.global,
          projects: { ...settings.handoff.projects },
        },
      },
    })
    const app = useAppPreferences.getState().values
    const appPatch: Partial<typeof app> = {}
    if (settings.theme && settings.theme !== app.theme) appPatch.theme = settings.theme
    if (settings.defaultWorkspace && settings.defaultWorkspace !== app.defaultWorkspace)
      appPatch.defaultWorkspace = settings.defaultWorkspace
    if (Object.keys(appPatch).length) useAppPreferences.getState().update(appPatch)
    if (settings.notifications) {
      const n = useNotificationPrefs.getState().values
      if (
        n.needsYou !== settings.notifications.needsYou ||
        n.turnDone !== settings.notifications.turnDone
      ) {
        useNotificationPrefs.getState().update({
          needsYou: settings.notifications.needsYou,
          turnDone: settings.notifications.turnDone,
        })
      }
    }
  } finally {
    applying.delete(hostKey)
  }
}

export function applyHostSettingsRecord(hostKey: string, record: SharedSettingsRecord) {
  useHostSettings.getState().apply(hostKey, record)
  hydrateLocalStores(hostKey, record.settings)
}

export function localSharedSettingsFor(hostKey: string): LocalSharedSettings {
  const prefs = usePreferences.getState().hosts[hostKey]
  const handoff = useAutoHandoff.getState().hosts[hostKey]
  const app = useAppPreferences.getState().values
  const notes = useNotificationPrefs.getState().values
  return {
    defaultInstanceId: prefs?.instanceId,
    agentDefaults: prefs?.agents,
    handoff: handoff ?? { global: defaultHandoffPolicy, projects: {} },
    theme: app.theme,
    defaultWorkspace: app.defaultWorkspace,
    notifications: {
      needsYou: notes.needsYou,
      turnDone: notes.turnDone,
      error: true,
      schedule: true,
    },
  }
}

type SettingsClient = Pick<HostClient, 'request'>

const clients = new Map<string, SettingsClient>()

export function bindHostSettingsClient(hostKey: string, client: SettingsClient) {
  clients.set(hostKey, client)
}

export function unbindHostSettingsClient(hostKey: string, client?: SettingsClient) {
  if (!client || clients.get(hostKey) === client) clients.delete(hostKey)
}

/** Load the host document, upload leftover local values if it is still empty, and hydrate stores. */
export async function pullAndApplyHostSettings(hostKey: string, client: SettingsClient) {
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

/** Write a patch to the host and replace the local copy with what it returns. */
export async function updateHostSettings(hostKey: string, patch: SharedSettingsPatch) {
  const client = clients.get(hostKey)
  if (!client) throw new Error('That host is not connected')
  const baseVersion = useHostSettings.getState().records[hostKey]?.version
  const record = await client.request('settings.update', { patch, baseVersion })
  applyHostSettingsRecord(hostKey, record)
  return record
}

export function isApplyingHostSettings(hostKey: string) {
  return applying.has(hostKey)
}

/** Best connected host to receive a setting that the UI treats as app-wide (theme, workspace). */
export function preferredSettingsHost(keys: string[]): string | undefined {
  return keys.find((key) => clients.has(key)) ?? keys[0]
}

function pushToHost(hostKey: string, patch: SharedSettingsPatch) {
  if (applying.has(hostKey) || !clients.has(hostKey)) return
  void updateHostSettings(hostKey, patch).catch(() => {
    // The next settings.changed or a later edit will refresh; the local store already has the choice.
  })
}

function pushAppWide(patch: SharedSettingsPatch) {
  if (applying.size > 0) return
  for (const key of clients.keys()) pushToHost(key, patch)
}

setPreferencesPush((hostKey, patch) => pushToHost(hostKey, patch))
setHandoffPush((hostKey, patch) => pushToHost(hostKey, patch))
setAppPreferencesPush((patch) => {
  const body: SharedSettingsPatch = {}
  if (patch.theme !== undefined) body.theme = patch.theme
  if (patch.defaultWorkspace !== undefined) body.defaultWorkspace = patch.defaultWorkspace
  if (Object.keys(body).length) pushAppWide(body)
})
setNotificationPrefsPush((patch) => {
  const notifications: NonNullable<SharedSettingsPatch['notifications']> = {}
  if (patch.needsYou !== undefined) notifications.needsYou = patch.needsYou
  if (patch.turnDone !== undefined) notifications.turnDone = patch.turnDone
  if (Object.keys(notifications).length) pushAppWide({ notifications })
})
