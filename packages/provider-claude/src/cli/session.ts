import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionModeOption, QuestionSpec, SessionEvent } from '@beddcode/contracts'
import type { PromptInput, ProviderSession, StartSessionInput } from '@beddcode/provider-core'
import {
  createAsyncQueue,
  deferred,
  type Deferred,
  type Logger,
  type SupervisedProcess,
  type SupervisorClient,
} from '@beddcode/shared'
import { ClaudeEventMapper, toolKind, toolTitle } from '../mapper.ts'
import { ApprovalBridge, SOCKET_ENV, type ApprovalRequest } from './approvalBridge.ts'
import { ClaudeCliProcess } from './process.ts'
import { approvalBridgeProgram } from './approvalBridgeProgram.ts'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never
export interface ClaudeCliSessionDeps {
  executablePath?: string
  env?: Record<string, string | undefined>
  log: Logger
  modes?: PermissionModeOption[]
  /** Starts the agent under the supervisor, which keeps it running if the host restarts. */
  supervisor?: SupervisorClient
  /** An agent a previous host left with the supervisor, to carry on with instead of starting one. */
  attached?: SupervisedProcess
  /** See `CliOptions.launchArgs`. */
  launchArgs?: string[]
}

export class ClaudeCliSession implements ProviderSession {
  readonly sessionId: string
  private readonly queue = createAsyncQueue<SessionEvent>()
  private readonly mapper: ClaudeEventMapper
  private readonly bridge?: ApprovalBridge
  private readonly ready: Promise<void>
  private process?: ClaudeCliProcess
  /** This session took over an agent that was already running (and maybe mid-turn). */
  readonly reattached: boolean
  private closed = false
  private active = false
  private currentTurn?: string
  private model: string | undefined
  private effort: string | undefined
  private permissionMode: string | undefined
  private providerId: string | undefined
  private restartNeeded = false
  private idleTimer?: NodeJS.Timeout
  private requests = 0
  private waiters: Deferred<void>[] = []
  private pending = new Map<
    string,
    { bridgeId: string; request: ApprovalRequest; questions?: Map<string, string> }
  >()
  constructor(
    private readonly input: StartSessionInput,
    private readonly deps: ClaudeCliSessionDeps,
  ) {
    this.model = input.model
    this.effort = input.effort
    this.permissionMode = input.permissionMode
    this.providerId = input.resumeId
    this.sessionId = input.sessionId
    this.mapper = new ClaudeEventMapper(input.sessionId, {
      cwd: input.cwd,
      resumed: !!input.resumeId,
    })
    this.reattached = deps.attached !== undefined
    const meta = deps.attached?.meta
    if (meta) {
      // Carry on in the turn the previous host left, with the id Claude knows this conversation by.
      if (typeof meta.providerId === 'string') this.providerId = meta.providerId
      if (meta.turnActive === true && typeof meta.currentTurn === 'string') {
        this.active = true
        this.currentTurn = meta.currentTurn
        this.mapper.setTurn(meta.currentTurn)
      }
    }
    // A reattached agent's approval helper dials the address it was started with: serve that one.
    const bridgePath =
      typeof meta?.bridgePath === 'string'
        ? meta.bridgePath
        : deps.attached || input.permissionMode === 'bypassPermissions'
          ? undefined
          : process.platform === 'win32'
            ? `\\\\.\\pipe\\beddcode-${randomUUID()}`
            : join(tmpdir(), `beddcode-${randomUUID()}.sock`)
    if (bridgePath) this.bridge = new ApprovalBridge(bridgePath)
    this.bridge?.on('request', (id: string, request: ApprovalRequest) => this.approval(id, request))
    this.ready = this.start()
    void this.ready.catch(() => {})
  }
  private async start() {
    await this.bridge?.start()
    if (this.closed) {
      await this.bridge?.stop()
      return
    }
    this.spawnProcess()
  }
  private spawnProcess() {
    const servers: Record<string, unknown> = Object.fromEntries(
      (this.input.mcpServers ?? []).map((m) => [
        m.name,
        { command: m.command, args: m.args, env: m.env },
      ]),
    )
    // The host is bundled into a single desktop file, so embed the bundled helper for both dev and production.
    if (this.bridge)
      servers.beddcode = {
        command: process.execPath,
        args: ['-e', approvalBridgeProgram],
        env: { [SOCKET_ENV]: this.bridge.path },
      }
    const attached = this.deps.attached
    this.deps.attached = undefined // only the first start takes the running agent over
    const supervisor = this.deps.supervisor
    this.process = new ClaudeCliProcess(
      {
        cwd: this.input.cwd,
        executablePath: this.deps.executablePath,
        launchArgs: this.deps.launchArgs,
        env: this.deps.env,
        model: this.model,
        effort: this.effort,
        resumeId: this.providerId,
        sessionId: this.providerId ? undefined : (this.providerId = randomUUID()),
        permissionMode: this.permissionMode ?? 'default',
        additionalDirectories: this.input.additionalDirectories,
        mcpConfig: Object.keys(servers).length
          ? JSON.stringify({ mcpServers: servers })
          : undefined,
        permissionPromptTool: this.bridge ? 'mcp__beddcode__approve' : undefined,
      },
      attached
        ? () => attached
        : supervisor
          ? (spec) => supervisor.spawn(this.sessionId, { ...spec, protocol: 'claude' }, this.meta())
          : undefined,
    )
    void this.pump(this.process)
    this.scheduleIdle()
  }
  get events() {
    return this.queue
  }
  /** What a later host needs to know to pick this agent up: its turn, conversation and approval address. */
  private meta() {
    return {
      turnActive: this.active,
      active: this.active,
      currentTurn: this.currentTurn,
      providerId: this.providerId,
      bridgePath: this.bridge?.path,
    }
  }
  private syncMeta() {
    this.process?.supervised?.setMeta(this.meta())
  }
  private emit(event: Draft, turnId?: string) {
    this.queue.push({ ...event, sessionId: this.sessionId, turnId, at: Date.now() } as SessionEvent)
  }
  private turn() {
    return this.currentTurn
  }
  private scheduleIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (!this.active) this.stopProcess()
    }, 10 * 60_000)
    this.idleTimer.unref()
  }
  private stopProcess() {
    const child = this.process
    this.process = undefined
    child?.close()
  }
  async prompt(input: PromptInput) {
    if (this.closed) throw new Error('session is closed')
    await this.ready
    if (this.closed) throw new Error('session is closed')
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.restartNeeded) {
      this.stopProcess()
      this.restartNeeded = false
    }
    if (!this.process) this.spawnProcess()
    const turn = (this.currentTurn = randomUUID())
    this.mapper.setTurn(turn)
    this.active = true
    this.syncMeta()
    const done = deferred<void>()
    this.waiters.push(done)
    this.emit({ type: 'turn.started' }, turn)
    try {
      await this.process!.send(input.text, input.attachments)
    } catch (err) {
      this.waiters.splice(this.waiters.indexOf(done), 1)
      this.active = false
      throw err
    }
    await done.promise
  }
  async steer(input: PromptInput) {
    if (!this.active) return this.prompt(input)
    await this.ready
    await this.process!.send(input.text, input.attachments, 'next')
  }
  async interrupt() {
    this.mapper.markInterrupted()
    this.denyPending('Interrupted')
    await this.ready
    try {
      await this.process?.control({ subtype: 'interrupt' })
    } catch {
      this.process?.interrupt()
    }
  }
  async setModel(model: string | undefined, effort: string | undefined) {
    await this.ready
    if (effort !== this.effort) {
      this.effort = effort
      this.model = model
      this.restartNeeded = true
    } else if (model !== this.model) {
      this.model = model
      if (!this.restartNeeded)
        await this.process?.control({ subtype: 'set_model', model: model ?? null })
    }
  }
  async setPermissionMode(mode: string) {
    this.permissionMode = mode
    await this.ready
    await this.process?.control({ subtype: 'set_permission_mode', mode })
  }
  private approval(bridgeId: string, request: ApprovalRequest) {
    if (
      (this.input.mcpServers ?? []).some((m) =>
        (m.autoAllow ?? []).some((t) => request.tool_name === `mcp__${m.name}__${t}`),
      )
    ) {
      this.bridge!.resolve(bridgeId, { behavior: 'allow', updatedInput: request.input })
      return
    }
    const id = `req-${++this.requests}`
    if (request.tool_name === 'AskUserQuestion') {
      const texts = new Map<string, string>()
      const questions: QuestionSpec[] = (
        Array.isArray(request.input.questions)
          ? (request.input.questions as Record<string, unknown>[])
          : []
      ).map((q, i) => {
        const qid = `q${i}`,
          question = typeof q.question === 'string' ? q.question : `Question ${i + 1}`
        texts.set(qid, question)
        return {
          id: qid,
          question,
          header: typeof q.header === 'string' ? q.header : undefined,
          options: Array.isArray(q.options)
            ? (q.options as Record<string, unknown>[]).map((o) => ({
                label: String(o.label ?? ''),
                description: typeof o.description === 'string' ? o.description : undefined,
              }))
            : undefined,
          multiSelect: q.multiSelect === true,
          allowOther: true,
        }
      })
      this.pending.set(id, { bridgeId, request, questions: texts })
      this.emit({ type: 'question.requested', requestId: id, questions }, this.turn())
      return
    }
    this.pending.set(id, { bridgeId, request })
    const plan =
      request.tool_name === 'ExitPlanMode' && typeof request.input.plan === 'string'
        ? request.input.plan
        : undefined
    const detail =
      typeof request.input.command === 'string'
        ? request.input.command
        : typeof request.input.file_path === 'string'
          ? request.input.file_path
          : undefined
    this.emit(
      {
        type: 'approval.requested',
        requestId: id,
        title:
          plan !== undefined
            ? 'Ready to start with this plan?'
            : `${toolTitle(request.tool_name, request.input, this.input.cwd)}?`,
        detail:
          plan !== undefined
            ? undefined
            : detail || (toolKind(request.tool_name) === 'other' ? undefined : undefined),
        plan,
        options:
          plan !== undefined
            ? [
                { id: 'allow', label: 'Approve plan', kind: 'allow' },
                { id: 'allow-edits', label: 'Approve and auto-accept edits', kind: 'allow' },
                { id: 'deny', label: 'Keep planning', kind: 'deny' },
              ]
            : [
                { id: 'allow', label: 'Allow', kind: 'allow' },
                { id: 'deny', label: 'Deny', kind: 'deny' },
              ],
      },
      this.turn(),
    )
  }
  async respondToApproval(id: string, option: string) {
    const p = this.pending.get(id)
    if (!p || p.questions) throw new Error(`No pending approval ${id}`)
    this.pending.delete(id)
    if (option === 'allow-edits') await this.setPermissionMode('acceptEdits')
    this.bridge!.resolve(
      p.bridgeId,
      option === 'deny'
        ? { behavior: 'deny', message: 'The user denied this action.' }
        : { behavior: 'allow', updatedInput: p.request.input },
    )
    this.emit({ type: 'approval.resolved', requestId: id, optionId: option }, this.turn())
  }
  async answerQuestion(id: string, answers?: Record<string, string[]>) {
    const p = this.pending.get(id)
    if (!p?.questions) throw new Error(`No pending question ${id}`)
    this.pending.delete(id)
    const mapped: Record<string, string> = {}
    for (const [key, value] of Object.entries(answers ?? {}))
      mapped[p.questions.get(key) ?? key] = value.join(', ')
    this.bridge!.resolve(
      p.bridgeId,
      answers
        ? { behavior: 'allow', updatedInput: { ...p.request.input, answers: mapped } }
        : { behavior: 'deny', message: 'The user dismissed the question.' },
    )
    this.emit({ type: 'question.resolved', requestId: id, answers }, this.turn())
  }
  private denyPending(message: string) {
    for (const [id, p] of this.pending) {
      this.bridge?.resolve(p.bridgeId, { behavior: 'deny', message })
      if (p.questions) this.emit({ type: 'question.resolved', requestId: id }, this.turn())
      else this.emit({ type: 'approval.resolved', requestId: id, optionId: 'deny' }, this.turn())
    }
    this.pending.clear()
  }
  /**
   * The host is going away but the agent is to keep running (see docs/agent-supervisor.md). Without
   * the supervisor this is just `close`.
   */
  async detach() {
    if (this.closed) return
    if (!this.process?.supervised) return this.close()
    this.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.syncMeta()
    this.process.detach()
    this.process = undefined
    await this.bridge?.stop()
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('session closed'))
    this.queue.close()
  }
  async close() {
    if (this.closed) return
    this.closed = true
    this.denyPending('Session closed')
    await this.ready.catch(() => {})
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.stopProcess()
    await this.bridge?.stop()
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('session closed'))
    this.queue.close()
  }
  private async pump(child: ClaudeCliProcess) {
    try {
      for await (const msg of child.messages()) {
        const id = this.mapper.providerSessionId(msg)
        if (id) this.providerId = id
        for (const event of this.mapper.map(msg)) {
          this.queue.push(event)
          if (event.type === 'turn.completed') {
            this.active = false
            this.syncMeta()
            this.waiters.shift()?.resolve()
            this.scheduleIdle()
          }
        }
      }
    } catch (err) {
      if (!this.closed && this.process === child) {
        this.deps.log.error(`claude stream failed for ${this.sessionId}`, err)
        this.emit(
          { type: 'error', message: err instanceof Error ? err.message : String(err) },
          this.turn(),
        )
        this.emit({ type: 'turn.completed', reason: 'error' }, this.turn())
        for (const waiter of this.waiters.splice(0)) waiter.resolve()
      }
    } finally {
      if (this.process !== child) return
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Claude process ended'))
      if (!this.closed) {
        this.closed = true
        this.denyPending('Process ended')
        await this.bridge?.stop()
        this.queue.close()
      }
    }
  }
}
