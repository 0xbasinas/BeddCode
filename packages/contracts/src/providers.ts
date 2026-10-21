import { z } from 'zod'

/** Built-in provider kinds. `acp` covers every generic ACP agent instance. */
export const ProviderKind = z.enum(['claude', 'codex', 'acp', 'fake'])
export type ProviderKind = z.infer<typeof ProviderKind>

/**
 * Permission modes are owned by each CLI. We only carry the CLI's own mode ids and labels;
 * the UI shows whatever the provider reports.
 */
export const PermissionModeOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** Marks the "no prompts at all" style mode so the UI can warn. */
  dangerous: z.boolean().optional(),
})
export type PermissionModeOption = z.infer<typeof PermissionModeOption>

export const ModelOption = z.object({
  /** Passed to the provider as-is when the user picks it. */
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
})
export type ModelOption = z.infer<typeof ModelOption>

/** What a provider really supports. The UI reads these flags, never the provider kind. */
export const ProviderCapabilities = z.object({
  resume: z.boolean(),
  fork: z.boolean(),
  steer: z.boolean(),
  planMode: z.boolean(),
  imageInput: z.boolean(),
  usage: z.boolean(),
  permissionModes: z.array(PermissionModeOption),
  /** Models the user can choose at session start; absent when the provider picks its own. */
  models: z.array(ModelOption).optional(),
  /** Reasoning effort levels the provider accepts (ids as the provider spells them). */
  efforts: z.array(z.string()).optional(),
})
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>

export const ProviderStatus = z.enum(['ready', 'needs-sign-in', 'not-installed', 'error'])
export type ProviderStatus = z.infer<typeof ProviderStatus>

export const ProviderInstance = z.object({
  id: z.string(),
  kind: ProviderKind,
  label: z.string(),
  status: ProviderStatus,
  version: z.string().optional(),
  capabilities: ProviderCapabilities,
})
export type ProviderInstance = z.infer<typeof ProviderInstance>
