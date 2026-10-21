import type { ProviderCapabilities, ProviderInstance, SessionEvent } from '@beddcode/contracts'

export interface StartSessionInput {
  sessionId: string
  /** Absolute path on the host the agent works in (project folder or worktree). */
  cwd: string
  model?: string
  effort?: string
  /** One of the ids reported in `capabilities.permissionModes`. */
  permissionMode?: string
  /** Extra folders the agent may read without asking (e.g. where attachments are stored). */
  additionalDirectories?: string[]
  /** Provider-native id to resume, when the provider supports it. */
  resumeId?: string
}

export interface PromptInput {
  text: string
  /** Absolute paths of attachments already stored on the host. */
  attachments?: string[]
}

export interface ProviderSession {
  readonly sessionId: string
  /** Normalized events for the whole session lifetime. */
  readonly events: AsyncIterable<SessionEvent>
  prompt(input: PromptInput, signal?: AbortSignal): Promise<void>
  interrupt(): Promise<void>
  setPermissionMode(modeId: string): Promise<void>
  /** Answer an `approval.requested` event with one of the provider's own option ids. */
  respondToApproval(requestId: string, optionId: string): Promise<void>
  close(): Promise<void>
}

/** One adapter per provider kind; instances come from `detect`. */
export interface ProviderAdapter {
  readonly kind: ProviderInstance['kind']
  /** Cheap check: installed? signed in? Must not start sessions that run hooks or MCP servers. */
  detect(): Promise<ProviderInstance[]>
  capabilities(instanceId: string): ProviderCapabilities
  startSession(instanceId: string, input: StartSessionInput): Promise<ProviderSession>
}
