import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '@beddcode/contracts'
import type { ProviderSession, PromptInput, StartSessionInput } from '@beddcode/provider-core'
import { createAsyncQueue, deferred, type Deferred, type Logger } from '@beddcode/shared'
import { ClaudeEventMapper, toolKind, toolTitle } from './mapper.ts'

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options?: Options
}) => Query

export interface ClaudeSessionDeps {
  queryFn: QueryFn
  log: Logger
  /** Path to the user's installed `claude` binary. */
  executablePath?: string
  env?: Record<string, string | undefined>
}

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never

interface PendingApproval {
  resolve(result: PermissionResult): void
  input: Record<string, unknown>
  suggestions: PermissionResultSuggestions
}
type PermissionResultSuggestions = Extract<
  PermissionResult,
  { behavior: 'allow' }
>['updatedPermissions']

const ALLOW = 'allow'
const ALLOW_SESSION = 'allow-session'
const DENY = 'deny'

/**
 * One Claude Code conversation. Runs a single long-lived `query()` fed by a prompt queue so
 * follow-up messages reuse the same process. Permission prompts are forwarded unchanged; the
 * user's answer is returned to Claude's own permission system.
 */
export class ClaudeSession implements ProviderSession {
  readonly sessionId: string
  private readonly queue = createAsyncQueue<SessionEvent>()
  private readonly prompts = createAsyncQueue<SDKUserMessage>()
  private readonly mapper: ClaudeEventMapper
  private readonly query: Query
  private readonly turnWaiters: Deferred<void>[] = []
  private readonly pending = new Map<string, PendingApproval>()
  private readonly abort = new AbortController()
  private turnCount = 0
  private approvalCount = 0
  private closed = false

  constructor(
    private readonly input: StartSessionInput,
    private readonly deps: ClaudeSessionDeps,
  ) {
    this.sessionId = input.sessionId
    this.mapper = new ClaudeEventMapper(input.sessionId, { cwd: input.cwd })

    this.query = deps.queryFn({
      prompt: this.prompts,
      options: {
        cwd: input.cwd,
        model: input.model,
        effort: input.effort as Options['effort'],
        permissionMode: (input.permissionMode ?? 'default') as PermissionMode,
        // Lets the user switch to "Full access" mid-session; it is only ever their choice.
        allowDangerouslySkipPermissions: true,
        additionalDirectories: input.additionalDirectories,
        resume: input.resumeId,
        includePartialMessages: true,
        // Honour the user's own Claude settings, CLAUDE.md and permission rules.
        settingSources: ['user', 'project', 'local'],
        pathToClaudeCodeExecutable: deps.executablePath,
        env: { ...process.env, ...deps.env },
        abortController: this.abort,
        canUseTool: this.canUseTool,
      },
    })
    void this.pump()
  }

  get events() {
    return this.queue
  }

  private emit(draft: Draft, turnId?: string) {
    this.queue.push({ ...draft, sessionId: this.sessionId, turnId, at: Date.now() } as SessionEvent)
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.closed) throw new Error('session is closed')
    const turnId = `turn-${++this.turnCount}`
    this.mapper.setTurn(turnId)
    const done = deferred<void>()
    this.turnWaiters.push(done)
    this.emit({ type: 'turn.started' }, turnId)
    this.prompts.push({
      type: 'user',
      message: { role: 'user', content: input.text },
      parent_tool_use_id: null,
    })
    await done.promise
  }

  async interrupt() {
    this.mapper.markInterrupted()
    this.denyAllPending('Interrupted')
    await this.query.interrupt()
  }

  async setPermissionMode(modeId: string) {
    await this.query.setPermissionMode(modeId as PermissionMode)
  }

  async respondToApproval(requestId: string, optionId: string) {
    const waiting = this.pending.get(requestId)
    if (!waiting) throw new Error(`No pending approval ${requestId}`)
    this.pending.delete(requestId)

    if (optionId === DENY) {
      waiting.resolve({ behavior: 'deny', message: 'The user denied this action.' })
    } else if (optionId === ALLOW_SESSION) {
      waiting.resolve({
        behavior: 'allow',
        updatedInput: waiting.input,
        updatedPermissions: waiting.suggestions,
      })
    } else {
      waiting.resolve({ behavior: 'allow', updatedInput: waiting.input })
    }
    this.emit({ type: 'approval.resolved', requestId, optionId }, this.currentTurn())
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.denyAllPending('Session closed')
    this.prompts.close()
    this.abort.abort()
    this.query.close()
    this.failTurns(new Error('session closed'))
    this.queue.close()
  }

  private currentTurn() {
    return `turn-${this.turnCount}`
  }

  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const requestId = `req-${++this.approvalCount}`
    const kind = toolKind(toolName)
    const detail =
      (typeof input.command === 'string' && input.command) ||
      (typeof input.file_path === 'string' && input.file_path) ||
      undefined
    const canRemember = (options.suggestions?.length ?? 0) > 0 && !options.suppressAlwaysAllowRule

    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, input, suggestions: options.suggestions })
      options.signal.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(requestId)) resolve({ behavior: 'deny', message: 'Cancelled' })
        },
        { once: true },
      )
      this.emit(
        {
          type: 'approval.requested',
          requestId,
          title: options.title ?? `${toolTitle(toolName, input, this.input.cwd)}?`,
          detail: detail || (kind === 'other' ? options.description : undefined),
          options: [
            { id: ALLOW, label: 'Allow', kind: 'allow' },
            { id: DENY, label: 'Deny', kind: 'deny' },
            ...(canRemember
              ? [{ id: ALLOW_SESSION, label: 'Always for this session', kind: 'allow' as const }]
              : []),
          ],
        },
        this.currentTurn(),
      )
    })
  }

  private denyAllPending(message: string) {
    for (const [requestId, waiting] of this.pending) {
      waiting.resolve({ behavior: 'deny', message })
      this.emit({ type: 'approval.resolved', requestId, optionId: DENY }, this.currentTurn())
    }
    this.pending.clear()
  }

  private failTurns(error: Error) {
    for (const w of this.turnWaiters.splice(0)) w.reject(error)
  }

  private async pump() {
    try {
      for await (const msg of this.query) {
        for (const event of this.mapper.map(msg)) {
          this.queue.push(event)
          if (event.type === 'turn.completed') this.turnWaiters.shift()?.resolve()
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.deps.log.error(`claude stream failed for ${this.sessionId}`, err)
        this.emit(
          { type: 'error', message: err instanceof Error ? err.message : String(err) },
          this.currentTurn(),
        )
        this.emit({ type: 'turn.completed', reason: 'error' }, this.currentTurn())
        for (const w of this.turnWaiters.splice(0)) w.resolve()
      }
    } finally {
      // Process exited: unblock any caller still waiting on a turn.
      this.failTurns(new Error('Claude process ended'))
      if (!this.closed) {
        this.closed = true
        this.queue.close()
      }
    }
  }
}
