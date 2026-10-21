import type { QuestionSpec, SessionEvent } from '@beddcode/contracts'
import type { ProviderSession, PromptInput, StartSessionInput } from '@beddcode/provider-core'
import {
  JsonRpcClient,
  JsonRpcError,
  createAsyncQueue,
  deferred,
  type Deferred,
  type Logger,
  type Transport,
} from '@beddcode/shared'
import { CodexEventMapper, commandTitle, fileChangeTitle, type FileChange } from './mapper.ts'
import { skillsToCommands } from './history.ts'
import { modeById, sandboxPolicy, type CodexMode } from './modes.ts'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never
type Obj = Record<string, unknown>

export interface CodexSessionDeps {
  transport: Transport
  log: Logger
  clientVersion?: string
}

const ALLOW = 'allow'
const ALLOW_SESSION = 'allow-session'
const DENY = 'deny'

interface PendingApproval {
  /** Builds the JSON-RPC result for the option the user picked. */
  answer(optionId: string): unknown
  resolve(result: unknown): void
}

/**
 * One Codex thread served by its own `codex app-server` process. Approval requests from Codex are
 * relayed to the user unchanged and the chosen option is sent back as Codex's own decision.
 */
export class CodexSession implements ProviderSession {
  readonly sessionId: string
  private readonly queue = createAsyncQueue<SessionEvent>()
  private readonly rpc: JsonRpcClient
  private readonly mapper: CodexEventMapper
  private readonly turnWaiters: Deferred<void>[] = []
  private readonly pending = new Map<string, PendingApproval>()
  private readonly questions = new Map<string, (result: unknown) => void>()
  /** Skill name to the path Codex wants when a skill is invoked. */
  private readonly skills = new Map<string, string>()
  private readonly ready: Promise<void>
  private threadId: string | null = null
  private codexTurnId: string | null = null
  private turnCount = 0
  private approvalCount = 0
  private closed = false
  private modeOverride: CodexMode | null = null
  private model: string | undefined
  private effort: string | undefined

  constructor(
    private readonly input: StartSessionInput,
    private readonly deps: CodexSessionDeps,
  ) {
    this.sessionId = input.sessionId
    this.model = input.model
    this.effort = input.effort
    this.mapper = new CodexEventMapper(input.sessionId, input.cwd)
    this.rpc = new JsonRpcClient(deps.transport, deps.log)
    this.rpc.onNotification((method, params) => this.onNotification(method, params))
    this.rpc.onRequest((method, params) => this.onServerRequest(method, params))
    this.rpc.onClose(() => this.fail('The Codex process ended unexpectedly'))
    this.ready = this.init()
    // A failed start is reported through events; callers awaiting `ready` see the rejection too.
    this.ready.catch(() => {})
  }

  get events() {
    return this.queue
  }

  private emit(draft: Draft, turnId?: string) {
    this.queue.push({ ...draft, sessionId: this.sessionId, turnId, at: Date.now() } as SessionEvent)
  }

  private async init() {
    try {
      await this.rpc.request('initialize', {
        clientInfo: {
          name: 'beddcode',
          title: 'BeddCode',
          version: this.deps.clientVersion ?? '0.0.0',
        },
        capabilities: null,
      })
      this.rpc.notify('initialized')

      const mode = modeById(this.input.permissionMode)
      const common = {
        cwd: this.input.cwd,
        approvalPolicy: mode.approvalPolicy,
        sandbox: mode.sandbox,
        ...(this.model ? { model: this.model } : {}),
      }
      const res = this.input.resumeId
        ? await this.rpc.request<{ thread: { id: string } }>('thread/resume', {
            threadId: this.input.resumeId,
            ...common,
            excludeTurns: true,
          })
        : await this.rpc.request<{ thread: { id: string } }>('thread/start', common)
      this.threadId = res.thread.id
      this.emit({ type: 'session.provider-session', providerSessionId: this.threadId })
      void this.announceSkills()
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /** Codex lists its skills per folder; they appear in the composer as commands. */
  private async announceSkills() {
    try {
      const res = await this.rpc.request<{ data: { skills: Obj[] }[] }>('skills/list', {
        cwds: [this.input.cwd],
      })
      const skills = res.data.flatMap((entry) => entry.skills).filter((s) => s.enabled !== false)
      for (const s of skills) {
        if (typeof s.name === 'string' && typeof s.path === 'string')
          this.skills.set(s.name, s.path)
      }
      if (this.closed) return
      this.emit({ type: 'session.commands', commands: skillsToCommands(skills) })
    } catch (err) {
      this.deps.log.debug(`could not read Codex skills for ${this.sessionId}`, err)
    }
  }

  /** A leading `/skill` or `$skill` names a skill, which Codex takes as its own input item. */
  private inputFor(text: string): Obj[] {
    const match = /^[/$]([\w.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
    const path = match && this.skills.get(match[1]!)
    if (!match || !path) return [{ type: 'text', text, text_elements: [] }]
    const rest = match[2]?.trim()
    return [
      { type: 'skill', name: match[1], path },
      ...(rest ? [{ type: 'text', text: rest, text_elements: [] }] : []),
    ]
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.closed) throw new Error('session is closed')
    try {
      await this.ready
    } catch {
      return // the start-up failure was already reported as an error event
    }

    const turnId = `turn-${++this.turnCount}`
    this.mapper.setTurn(turnId)
    this.emit({ type: 'turn.started' }, turnId)
    const done = deferred<void>()
    this.turnWaiters.push(done)

    try {
      const res = await this.rpc.request<{ turn: { id: string } }>('turn/start', {
        threadId: this.threadId,
        input: this.inputFor(input.text),
        // Sent with every turn, so a model chosen mid-session sticks for the rest of the thread.
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
        ...this.takeModeOverride(),
      })
      this.codexTurnId = res.turn.id
    } catch (err) {
      // Report the failure as a finished turn so the UI never waits on one that cannot complete.
      this.turnWaiters.splice(this.turnWaiters.indexOf(done), 1)
      this.emit(
        { type: 'error', message: err instanceof Error ? err.message : String(err) },
        turnId,
      )
      this.emit({ type: 'turn.completed', reason: 'error' }, turnId)
      return
    }
    await done.promise
  }

  /**
   * Adds to the turn that is running (`turn/steer`). When the turn just ended, or is of a kind
   * that cannot take extra input, the message starts a turn of its own instead.
   */
  async steer(input: PromptInput): Promise<void> {
    if (this.closed) throw new Error('session is closed')
    await this.ready
    if (!this.threadId || !this.codexTurnId) return this.prompt(input)
    try {
      await this.rpc.request('turn/steer', {
        threadId: this.threadId,
        input: this.inputFor(input.text),
        expectedTurnId: this.codexTurnId,
      })
    } catch (err) {
      if (!this.codexTurnId) return this.prompt(input)
      throw err
    }
  }

  async answerQuestion(requestId: string, answers?: Record<string, string[]>) {
    const resolve = this.questions.get(requestId)
    if (!resolve) throw new Error(`No pending question ${requestId}`)
    this.questions.delete(requestId)
    resolve({
      answers: Object.fromEntries(
        Object.entries(answers ?? {}).map(([id, values]) => [id, { answers: values }]),
      ),
    })
    this.emit({ type: 'question.resolved', requestId, answers }, this.currentTurn())
  }

  async interrupt() {
    this.resolveAllPending('cancel')
    if (this.threadId && this.codexTurnId) {
      await this.rpc.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.codexTurnId,
      })
    }
  }

  /** Applied with the next turn, which carries the model and effort. */
  async setModel(model: string | undefined, effort: string | undefined) {
    this.model = model
    this.effort = effort
  }

  async setPermissionMode(modeId: string) {
    // Applied with the next turn; Codex keeps it for the rest of the thread.
    this.modeOverride = modeById(modeId)
  }

  async respondToApproval(requestId: string, optionId: string) {
    const waiting = this.pending.get(requestId)
    if (!waiting) throw new Error(`No pending approval ${requestId}`)
    this.pending.delete(requestId)
    waiting.resolve(waiting.answer(optionId))
    this.emit({ type: 'approval.resolved', requestId, optionId }, this.currentTurn())
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.resolveAllPending('cancel')
    this.rpc.close()
    this.releaseTurns()
    this.queue.close()
  }

  private currentTurn() {
    return `turn-${this.turnCount}`
  }

  private takeModeOverride(): Obj {
    const mode = this.modeOverride
    this.modeOverride = null
    return mode
      ? { approvalPolicy: mode.approvalPolicy, sandboxPolicy: sandboxPolicy(mode.sandbox) }
      : {}
  }

  private onNotification(method: string, params: unknown) {
    const p = (params ?? {}) as Obj
    if (p.threadId !== undefined && p.threadId !== this.threadId) return

    for (const event of this.mapper.map(method, params)) {
      this.queue.push(event)
      if (event.type === 'turn.completed') {
        this.codexTurnId = null
        this.turnWaiters.shift()?.resolve()
      }
    }
  }

  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Obj
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const command = typeof p.command === 'string' ? p.command : undefined
        return this.askApproval({
          title:
            typeof p.reason === 'string' && p.reason
              ? p.reason
              : `${command ? commandTitle(command) : 'Run a command'}?`,
          detail: command,
          canRemember: true,
          answer: (id) => ({ decision: decisionFor(id) }),
        })
      }
      case 'item/fileChange/requestApproval': {
        const item = this.mapper.item(String(p.itemId))
        const changes = (item?.changes as FileChange[] | undefined) ?? []
        return this.askApproval({
          title:
            typeof p.reason === 'string' && p.reason
              ? p.reason
              : `${changes.length > 0 ? fileChangeTitle(changes, this.input.cwd) : 'Apply file changes'}?`,
          detail: changes.map((c) => c.path).join('\n') || undefined,
          canRemember: true,
          answer: (id) => ({ decision: decisionFor(id) }),
        })
      }
      case 'item/permissions/requestApproval':
        return this.askApproval({
          title:
            typeof p.reason === 'string' && p.reason ? p.reason : 'Grant additional permissions?',
          canRemember: true,
          answer: (id) =>
            id === DENY
              ? { permissions: {}, scope: 'turn' }
              : {
                  permissions: p.permissions ?? {},
                  scope: id === ALLOW_SESSION ? 'session' : 'turn',
                },
        })
      case 'item/tool/requestUserInput':
        return this.askQuestions(p)
      // MCP forms are not supported yet; decline rather than leave Codex waiting.
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null }
      default:
        throw new JsonRpcError(-32601, `Method not found: ${method}`)
    }
  }

  /** Codex's request_user_input: the answers go back keyed by question id. */
  private askQuestions(p: Obj): Promise<unknown> {
    const asked = Array.isArray(p.questions) ? (p.questions as Obj[]) : []
    const specs: QuestionSpec[] = asked.map((q) => ({
      id: String(q.id),
      header: typeof q.header === 'string' ? q.header : undefined,
      question: String(q.question ?? ''),
      options: Array.isArray(q.options)
        ? (q.options as Obj[]).map((o) => ({
            label: String(o.label ?? ''),
            description: typeof o.description === 'string' ? o.description : undefined,
          }))
        : undefined,
      allowOther: q.isOther === true || !Array.isArray(q.options),
      secret: q.isSecret === true,
    }))
    const requestId = `req-${++this.approvalCount}`
    return new Promise((resolve) => {
      this.questions.set(requestId, resolve)
      this.emit({ type: 'question.requested', requestId, questions: specs }, this.currentTurn())
    })
  }

  private askApproval(opts: {
    title: string
    detail?: string
    canRemember: boolean
    answer(optionId: string): unknown
  }): Promise<unknown> {
    const requestId = `req-${++this.approvalCount}`
    return new Promise((resolve) => {
      this.pending.set(requestId, { answer: opts.answer, resolve })
      this.emit(
        {
          type: 'approval.requested',
          requestId,
          title: opts.title,
          detail: opts.detail,
          options: [
            { id: ALLOW, label: 'Allow', kind: 'allow' },
            { id: DENY, label: 'Deny', kind: 'deny' },
            ...(opts.canRemember
              ? [{ id: ALLOW_SESSION, label: 'Always for this session', kind: 'allow' as const }]
              : []),
          ],
        },
        this.currentTurn(),
      )
    })
  }

  /** Answers every open approval with Codex's own "cancel" and tells the UI. */
  private resolveAllPending(decision: 'cancel') {
    for (const [requestId, resolve] of this.questions) {
      resolve({ answers: {} })
      this.emit({ type: 'question.resolved', requestId }, this.currentTurn())
    }
    this.questions.clear()
    for (const [requestId, waiting] of this.pending) {
      waiting.resolve({ decision })
      this.emit({ type: 'approval.resolved', requestId, optionId: DENY }, this.currentTurn())
    }
    this.pending.clear()
  }

  private releaseTurns() {
    for (const w of this.turnWaiters.splice(0)) w.resolve()
  }

  /** The process is unusable: surface the reason, finish any running turn, end the stream. */
  private fail(message: string) {
    if (this.closed) return
    this.closed = true
    this.emit({ type: 'error', message }, this.currentTurn())
    if (this.turnWaiters.length > 0)
      this.emit({ type: 'turn.completed', reason: 'error' }, this.currentTurn())
    this.releaseTurns()
    this.queue.close()
  }
}

function decisionFor(optionId: string): 'accept' | 'acceptForSession' | 'decline' {
  if (optionId === ALLOW) return 'accept'
  if (optionId === ALLOW_SESSION) return 'acceptForSession'
  return 'decline'
}
