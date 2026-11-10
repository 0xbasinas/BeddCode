import {
  emptySharedSettings,
  type SharedSettings,
  type SharedSettingsPatch,
  type SharedSettingsRecord,
} from '@beddcode/contracts'

/** True when this host has never saved shared settings (first client may upload its local copy). */
export function hostSettingsAreUnset(record: SharedSettingsRecord): boolean {
  return record.version === 0
}

export interface LocalSharedSettings {
  defaultInstanceId?: string
  agentDefaults?: SharedSettings['agentDefaults']
  handoff?: SharedSettings['handoff']
  autoReview?: SharedSettings['autoReview']
  theme?: SharedSettings['theme']
  defaultWorkspace?: SharedSettings['defaultWorkspace']
  notifications?: SharedSettings['notifications']
}

/** Build a first-connect upload from this device's leftover local values. Empty if there is nothing to send. */
export function migrationPatch(local: LocalSharedSettings): SharedSettingsPatch | null {
  const patch: SharedSettingsPatch = {}
  let any = false
  if (local.defaultInstanceId) {
    patch.defaultInstanceId = local.defaultInstanceId
    any = true
  }
  if (local.agentDefaults && Object.keys(local.agentDefaults).length > 0) {
    patch.agentDefaults = local.agentDefaults
    any = true
  }
  const handoff = local.handoff
  if (
    handoff &&
    (handoff.global.mode !== 'off' ||
      handoff.global.fallback.length > 0 ||
      Object.keys(handoff.projects).length > 0)
  ) {
    patch.handoff = handoff
    any = true
  }
  if (local.autoReview) {
    patch.autoReview = local.autoReview
    any = true
  }
  if (local.theme) {
    patch.theme = local.theme
    any = true
  }
  if (local.defaultWorkspace) {
    patch.defaultWorkspace = local.defaultWorkspace
    any = true
  }
  if (local.notifications) {
    patch.notifications = local.notifications
    any = true
  }
  return any ? patch : null
}

export const defaultHostSettings = emptySharedSettings

/** Load shared settings, upload leftover local values when the host store is still empty, and keep the copy. */
export async function pullHostSettings(
  get: () => Promise<SharedSettingsRecord>,
  update: (patch: SharedSettingsPatch, baseVersion?: number) => Promise<SharedSettingsRecord>,
  local: LocalSharedSettings,
): Promise<SharedSettingsRecord> {
  const current = await get()
  if (!hostSettingsAreUnset(current)) return current
  const patch = migrationPatch(local)
  if (!patch) return current
  return update(patch, current.version)
}
