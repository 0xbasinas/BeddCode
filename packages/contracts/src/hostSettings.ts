import { z } from 'zod'

/** Default model, effort and permission mode for one agent on this host. */
export const AgentDefaults = z.object({
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  permissionMode: z.string().min(1).optional(),
})
export type AgentDefaults = z.infer<typeof AgentDefaults>

/** When a turn fails in a way another agent can continue, how this host should hand off. */
export const HandoffPolicySettings = z.object({
  mode: z.enum(['off', 'ask', 'auto']),
  fallback: z.array(z.string().min(1)).max(20),
  maxHops: z.number().int().min(0).max(20),
  cooldownMs: z.number().int().nonnegative().max(7 * 24 * 60 * 60_000),
})
export type HandoffPolicySettings = z.infer<typeof HandoffPolicySettings>

/** Event types the host should treat as “tell the user’s devices”, not per-device sound or quiet hours. */
export const HostNotificationPrefs = z.object({
  needsYou: z.boolean(),
  turnDone: z.boolean(),
  error: z.boolean(),
  schedule: z.boolean(),
})
export type HostNotificationPrefs = z.infer<typeof HostNotificationPrefs>

const defaultHandoff: HandoffPolicySettings = {
  mode: 'off',
  fallback: [],
  maxHops: 3,
  cooldownMs: 30 * 60_000,
}

/** Shared settings stored on the host and shown live on every connected client. */
export const SharedSettings = z.object({
  defaultInstanceId: z.string().min(1).optional(),
  agentDefaults: z.record(z.string(), AgentDefaults).default({}),
  handoff: z
    .object({
      global: HandoffPolicySettings.default(defaultHandoff),
      projects: z.record(z.string(), HandoffPolicySettings).default({}),
    })
    .default({ global: defaultHandoff, projects: {} }),
  /** Host-wide auto-review / approval style for new work. Per-agent permission modes also apply. */
  autoReview: z.enum(['off', 'ask', 'auto']).optional(),
  theme: z.enum(['system', 'dark', 'light']).optional(),
  defaultWorkspace: z.enum(['worktree', 'local']).optional(),
  notifications: HostNotificationPrefs.optional(),
})
export type SharedSettings = z.infer<typeof SharedSettings>

export const emptySharedSettings = (): SharedSettings =>
  SharedSettings.parse({
    agentDefaults: {},
    handoff: { global: defaultHandoff, projects: {} },
  })

/** A partial update. `null` on a scalar field clears it. A project handoff of `null` removes that override. */
export const SharedSettingsPatch = z.object({
  defaultInstanceId: z.string().min(1).nullable().optional(),
  agentDefaults: z.record(z.string(), AgentDefaults).optional(),
  handoff: z
    .object({
      global: HandoffPolicySettings.optional(),
      projects: z.record(z.string(), HandoffPolicySettings.nullable()).optional(),
    })
    .optional(),
  autoReview: z.enum(['off', 'ask', 'auto']).nullable().optional(),
  theme: z.enum(['system', 'dark', 'light']).nullable().optional(),
  defaultWorkspace: z.enum(['worktree', 'local']).nullable().optional(),
  notifications: HostNotificationPrefs.partial().optional(),
})
export type SharedSettingsPatch = z.infer<typeof SharedSettingsPatch>

/** The document every client should hold: settings plus a version for last-write-wins. */
export const SharedSettingsRecord = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int(),
  settings: SharedSettings,
  /**
   * True when the write was applied on top of a newer document than the client had
   * (`baseVersion` was behind). The patch still landed; the client should replace its copy.
   */
  merged: z.boolean().optional(),
})
export type SharedSettingsRecord = z.infer<typeof SharedSettingsRecord>
