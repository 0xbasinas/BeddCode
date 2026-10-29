import { z } from 'zod'

/** Built-in provider kinds. `acp` covers every generic ACP agent instance. */
export const ProviderKind = z.enum(['claude', 'codex', 'grok', 'acp', 'fake'])
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
  /** Model-specific effort choices, in the order reported by the provider. */
  efforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
})
export type ModelOption = z.infer<typeof ModelOption>

/** What a provider really supports. The UI reads these flags, never the provider kind. */
export const ProviderCapabilities = z.object({
  textGeneration: z.boolean().optional(),
  resume: z.boolean(),
  fork: z.boolean(),
  steer: z.boolean(),
  planMode: z.boolean(),
  imageInput: z.boolean(),
  usage: z.boolean(),
  /** The agent can ask the user questions mid-turn. */
  questions: z.boolean().optional(),
  /** The agent reports slash commands or skills. */
  commands: z.boolean().optional(),
  /** Earlier conversations can be listed and imported. */
  history: z.boolean().optional(),
  /** MCP servers can be listed and managed through the agent's own CLI. */
  mcp: z.boolean().optional(),
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
