import type {
  AgentPreview,
  McpServer,
  McpServerInput,
  ProviderCapabilities,
  ProviderInstance,
  SessionEvent,
  SlashCommand,
  UsageLimits,
} from '@beddcode/contracts'

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
  /** The agent's own settings to apply right after it starts (model, thinking level, ...). */
  config?: Record<string, string | boolean>
  /** Provider-native id to resume, when the provider supports it. */
  resumeId?: string
  /** Internal text generation from supplied context; adapters restrict tools for this job. */
  textOnly?: boolean
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
  /**
   * Adds a message to the turn that is running, so the agent sees it at its next step. Only
   * providers whose `capabilities.steer` is true implement it; the host queues otherwise.
   */
  steer?(input: PromptInput): Promise<void>
  interrupt(): Promise<void>
  setPermissionMode(modeId: string): Promise<void>
  /** Answer an `approval.requested` event with one of the provider's own option ids. */
  respondToApproval(requestId: string, optionId: string): Promise<void>
  /** Uses another model (and effort) from the next message on; `undefined` means the agent's default. */
  setModel?(model: string | undefined, effort: string | undefined): Promise<void>
  /** Changes one of the settings the agent reported in `session.config`. */
  setConfigOption?(optionId: string, value: string | boolean): Promise<void>
  /** Answer a `question.requested` event; `answers` is absent when the user dismissed it. */
  answerQuestion?(requestId: string, answers?: Record<string, string[]>): Promise<void>
  close(): Promise<void>
}

/** A conversation the agent's own CLI keeps, as listed before it is imported. */
export interface HistoryItem {
  id: string
  title: string
  updatedAt?: number
  cwd?: string
}

/** One exchange of a stored conversation, enough to show it in the transcript. */
export interface HistoryTurn {
  user: string
  assistant: string
}

export interface ProviderMcp {
  list(instanceId: string, cwd?: string): Promise<McpServer[]>
  add(instanceId: string, server: McpServerInput, cwd?: string): Promise<void>
  remove(instanceId: string, name: string, scope?: string, cwd?: string): Promise<void>
}

/** One adapter per provider kind; instances come from `detect`. */
export interface ProviderAdapter {
  readonly kind: ProviderInstance['kind']
  /** Cheap check: installed? signed in? Must not start sessions that run hooks or MCP servers. */
  detect(): Promise<ProviderInstance[]>
  capabilities(instanceId: string): ProviderCapabilities
  startSession(instanceId: string, input: StartSessionInput): Promise<ProviderSession>
  /** Isolated text generation using the CLI's existing account, outside a user conversation. */
  generateText?(input: {
    instanceId: string
    cwd: string
    prompt: string
    model?: string
  }): Promise<string>

  /** Conversations the agent's CLI has stored for a folder, newest first. */
  listHistory?(instanceId: string, cwd?: string): Promise<HistoryItem[]>
  /** The exchanges of one stored conversation. */
  readHistory?(instanceId: string, providerSessionId: string, cwd?: string): Promise<HistoryTurn[]>
  /**
   * Copies a stored conversation into a new one holding its first `throughTurn` exchanges (all when
   * omitted) and returns the new provider session id, ready to be resumed.
   */
  forkHistory?(
    instanceId: string,
    from: { providerSessionId: string; cwd: string; throughTurn?: number },
  ): Promise<string>
  /** What a new session would offer (modes, settings, commands), for agents that only say so by starting one. */
  preview?(instanceId: string, cwd?: string): Promise<AgentPreview>
  /** The plan limits the agent reports (5-hour and weekly windows), for those that can say. */
  limits?(instanceId: string): Promise<Pick<UsageLimits, 'plan' | 'windows' | 'note'>>
  /** Slash commands and skills available in a folder, without starting a session. */
  listCommands?(instanceId: string, cwd?: string): Promise<SlashCommand[]>
  readonly mcp?: ProviderMcp
}
