import { existsSync, readFileSync } from 'node:fs'
import {
  SharedSettings,
  SharedSettingsPatch,
  SharedSettingsRecord,
  emptySharedSettings,
  type SharedSettings as HostSettingsValue,
} from '@beddcode/contracts'
import { writeFileAtomic } from '@beddcode/shared'

function merge(current: HostSettingsValue, patch: SharedSettingsPatch): HostSettingsValue {
  const next: HostSettingsValue = {
    ...current,
    agentDefaults: { ...current.agentDefaults },
    handoff: {
      global: { ...current.handoff.global },
      projects: { ...current.handoff.projects },
    },
    notifications: current.notifications ? { ...current.notifications } : undefined,
  }
  if (patch.defaultInstanceId !== undefined)
    next.defaultInstanceId = patch.defaultInstanceId ?? undefined
  if (patch.agentDefaults) {
    for (const [id, defaults] of Object.entries(patch.agentDefaults))
      next.agentDefaults[id] = { ...(next.agentDefaults[id] ?? {}), ...defaults }
  }
  if (patch.handoff?.global) next.handoff.global = { ...next.handoff.global, ...patch.handoff.global }
  if (patch.handoff?.projects) {
    for (const [folder, policy] of Object.entries(patch.handoff.projects)) {
      if (policy === null) delete next.handoff.projects[folder]
      else next.handoff.projects[folder] = policy
    }
  }
  if (patch.autoReview !== undefined) next.autoReview = patch.autoReview ?? undefined
  if (patch.theme !== undefined) next.theme = patch.theme ?? undefined
  if (patch.defaultWorkspace !== undefined)
    next.defaultWorkspace = patch.defaultWorkspace ?? undefined
  if (patch.notifications) {
    next.notifications = {
      needsYou: patch.notifications.needsYou ?? next.notifications?.needsYou ?? true,
      turnDone: patch.notifications.turnDone ?? next.notifications?.turnDone ?? true,
      error: patch.notifications.error ?? next.notifications?.error ?? true,
      schedule: patch.notifications.schedule ?? next.notifications?.schedule ?? true,
    }
  }
  return SharedSettings.parse(next)
}

/** Host-backed shared settings, persisted to one JSON file and broadcast to every client. */
export class HostSettingsStore {
  private record: SharedSettingsRecord = {
    version: 0,
    updatedAt: 0,
    settings: emptySharedSettings(),
  }
  private listeners = new Set<(record: SharedSettingsRecord) => void>()

  constructor(private file: string) {
    if (!existsSync(file)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const parsed = SharedSettingsRecord.safeParse(raw)
      if (parsed.success) this.record = { ...parsed.data, merged: undefined }
    } catch {
      this.record = { version: 0, updatedAt: 0, settings: emptySharedSettings() }
    }
  }

  get(): SharedSettingsRecord {
    const { version, updatedAt, settings } = this.record
    return { version, updatedAt, settings }
  }

  /**
   * Apply a patch on top of the current document. If `baseVersion` is behind, the patch still
   * lands (field-level last-write-wins) and `merged` is true so the client can refresh.
   */
  update(patch: SharedSettingsPatch, baseVersion?: number, now = Date.now()): SharedSettingsRecord {
    const current = this.record
    const settings = merge(current.settings, patch)
    const merged = baseVersion !== undefined && baseVersion !== current.version
    const record: SharedSettingsRecord = {
      version: current.version + 1,
      updatedAt: now,
      settings,
    }
    this.record = record
    writeFileAtomic(
      this.file,
      `${JSON.stringify({ version: record.version, updatedAt: record.updatedAt, settings: record.settings }, null, 2)}\n`,
      { mode: 0o600 },
    )
    const view = merged ? { ...this.get(), merged: true } : this.get()
    for (const listener of this.listeners) listener(view)
    return view
  }

  onChange(listener: (record: SharedSettingsRecord) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
