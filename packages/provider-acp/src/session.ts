import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  InitializeResponse,
  PermissionOption,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionUpdate,
} from '@agentclientprotocol/sdk'
import type { ConfigOption, SessionEvent } from '@beddcode/contracts'
import type { ProviderSession, PromptInput, StartSessionInput } from '@beddcode/provider-core'
import {
  JsonRpcClient,
  JsonRpcError,
  createAsyncQueue,
  describeRpcError,
  type Logger,
  type Transport,
} from '@beddcode/shared'
import { evaluateIdleTick, idleTiming, isProgress, replaySettled } from './idle.ts'
import {
  GROK_PLAN_METHODS,
  GROK_QUESTION_METHODS,
  KEEP_PLANNING_FEEDBACK,
  elicitationQuestions,
  grokPlan,
  grokQuestions,
  modelOptionFromState,
  type AskedQuestions,
} from './questions.ts'
import { AcpEventMapper, toConfigOptions } from './mapper.ts'
import { allowOption, approvalSetup, isHostTool, type ModeSource } from './permissions.ts'
import type { AgentProfile } from './profiles.ts'
import { promptUsage, usageEvents } from './usage.ts'
import { TerminalManager } from './terminals.ts'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never
type Obj = Record<string, unknown>

const PROTOCOL_VERSION = 1
/** Starting up can legitimately take a while (an `npx` download, MCP servers); a hang cannot. */
const INIT_TIMEOUT = 30_000
const SESSION_TIMEOUT = 90_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** More than one allow option of the same kind: the request is a choice, not a yes or no. */
export function isChooser(options: { kind: string }[]): boolean {
  const seen = new Set<string>()
  for (const option of options) {
    if (!option.kind.startsWith('allow')) continue
    if (seen.has(option.kind)) return true
    seen.add(option.kind)
  }
  return false
}

/** The text a tool call carries in its content blocks. */
export function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts = content.flatMap((block) => {
    const inner = (block as { content?: { type?: string; text?: unknown } } | null)?.content
    return inner?.type === 'text' && typeof inner.text === 'string' && inner.text.trim()
      ? [inner.text.trim()]
      : []
  })
  return parts.length > 0 ? parts.join('\n').slice(0, 2000) : undefined
}

export interface AcpSessionDeps {
  transport: Transport
  log: Logger
  label: string
  clientVersion?: string
  /** What is known about this particular agent's approval setting (see profiles.ts). */
  profile?: AgentProfile
  /** The mode the agent was started in by its launch flags, so it does not have to be switched. */
  launchedMode?: string
}

interface SetupResponse {
  modes?: Modes
  configOptions?: SessionConfigOption[] | null
  /** Older agents list their models here instead of as a config option. */
  models?: unknown
}

/** Starting a session reads the agent's session storage, which can lag a moment behind. */
const STORAGE_RETRIES = 3
const STORAGE_RETRY_MS = 100
const isStorageNotFound = (err: unknown) =>
  err instanceof JsonRpcError &&
  typeof err.data === 'object' &&
  err.data !== null &&
  (err.data as { code?: unknown }).code === 'FS_NOT_FOUND'

/** After a resumed conversation is loaded, how long the agent must be silent before the replay is over. */
const REPLAY_QUIET_MS = 150
const REPLAY_HARD_MS = 2_000

interface Modes {
  currentModeId?: string
  availableModes?: { id: string; name: string; description?: string | null }[]
}

export class AcpSession implements ProviderSession {
  readonly sessionId: string
  private readonly queue = createAsyncQueue<SessionEvent>()
  private readonly rpc: JsonRpcClient
  private readonly mapper: AcpEventMapper
  private modes: { id: string; label: string; description?: string; dangerous?: boolean }[] = []
  /** Where the approval modes came from, which decides how a change is sent (see permissions.ts). */
  private modeSource: ModeSource = 'modes'
  private modeOptionId: string | undefined
  /** Mode `approve-all`, for agents with no mode of their own: answer permission requests with Allow. */
  private approveAll = false
  /** While a quiet prompt runs, the agent's words about it are not shown. */
  private quiet = false
  private readonly terminals: TerminalManager
  private readonly pending = new Map<string, (optionId: string | null) => void>()
  private readonly ready: Promise<void>
  private acpSessionId: string | null = null
  private turnCount = 0
  private inflightTurn: string | null = null
  private approvalCount = 0
  private closed = false
  /** While loading history the agent replays old messages; those must not become new events. */
  private replaying = false
  private lastReplayAt = 0
  /** The model list some agents give outside the config options, and the one now chosen. */
  private modelState: unknown
  private modelValue: string | undefined
  /** Questions the agent asked and is waiting on, by request id. */
  private readonly questionWaiters = new Map<string, (answers?: Record<string, string[]>) => void>()
  /** Turn watchdog: when the agent last showed it was working. */
  private lastProgressAt = 0
  private watchdog: ReturnType<typeof setInterval> | undefined
  private endTurn: (() => void) | undefined
  private canSendImages = false
  private canCloseSession = false

  constructor(
    private readonly input: StartSessionInput,
    private readonly deps: AcpSessionDeps,
  ) {
    this.sessionId = input.sessionId
    this.mapper = new AcpEventMapper(input.sessionId)
    if (input.resumeId) this.mapper.continuesEarlierConversation()
    this.terminals = new TerminalManager(input.cwd, input.terminalHost)
    this.rpc = new JsonRpcClient(deps.transport, deps.log, { jsonrpc2: true })
    this.rpc.onNotification((method, params) => this.onNotification(method, params))
    this.rpc.onRequest((method, params) => this.onClientRequest(method, params))
    this.rpc.onClose(() => this.fail(this.endMessage()))
    this.ready = this.init()
    this.ready.catch(() => {})
  }

  get events() {
    return this.queue
  }

  /** Why the process ended, with the last thing it said on stderr when that explains it. */
  private endMessage(): string {
    const tail = this.rpc.stderrTail.split('\n').filter(Boolean).at(-1)
    return tail
      ? `${this.deps.label} stopped unexpectedly: ${tail.slice(0, 300)}`
      : `${this.deps.label} stopped unexpectedly`
  }

  private emit(draft: Draft, turnId?: string) {
    this.queue.push({ ...draft, sessionId: this.sessionId, turnId, at: Date.now() } as SessionEvent)
  }

  private async init() {
    try {
      const init = await this.rpc.request<InitializeResponse>(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: this.input.textOnly
            ? {}
            : {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: true,
                // Forms an agent wants filled in go to the user as questions.
                elicitation: { form: {} },
              },
          clientInfo: {
            name: 'beddcode',
            title: 'BeddCode',
            version: this.deps.clientVersion ?? '0.0.0',
          },
        },
        { timeoutMs: INIT_TIMEOUT },
      )
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `${this.deps.label} speaks ACP v${init.protocolVersion}, which is not supported yet`,
        )
      }

      const caps = init.agentCapabilities
      this.canCloseSession = Boolean(
        caps?.sessionCapabilities && 'close' in caps.sessionCapabilities,
      )
      this.canSendImages = caps?.promptCapabilities?.image === true
      this.authMethods = (init.authMethods ?? []).map((m) => m.name)
      const extra = this.input.additionalDirectories ?? []
      const base = {
        cwd: this.input.cwd,
        // stdio servers are the one kind every ACP agent must accept.
        mcpServers: (this.input.mcpServers ?? []).map((m) => ({
          name: m.name,
          command: m.command,
          args: m.args,
          env: Object.entries(m.env).map(([name, value]) => ({ name, value })),
        })) as unknown[],
        // Only sent when the agent says it understands it.
        ...(extra.length > 0 && caps?.sessionCapabilities?.additionalDirectories
          ? { additionalDirectories: extra }
          : {}),
      }
      let modes: Modes | undefined
      let configOptions: SessionConfigOption[] | null | undefined
      let models: unknown

      if (this.input.resumeId) {
        this.acpSessionId = this.input.resumeId
        if (caps?.sessionCapabilities?.resume) {
          const res = await this.setup<SetupResponse>('session/resume', {
            sessionId: this.acpSessionId,
            ...base,
          })
          modes = res.modes
          configOptions = res.configOptions
          models = res.models
        } else if (caps?.loadSession) {
          this.replaying = true
          this.lastReplayAt = Date.now()
          const startedAt = Date.now()
          try {
            const res = await this.setup<SetupResponse>('session/load', {
              sessionId: this.acpSessionId,
              ...base,
            })
            modes = res.modes
            configOptions = res.configOptions
            models = res.models
            // Some agents go on replaying after the request has answered; wait for it to go quiet.
            while (
              !replaySettled({
                now: Date.now(),
                lastActivityAt: this.lastReplayAt,
                startedAt,
                quietMs: REPLAY_QUIET_MS,
                hardMs: REPLAY_HARD_MS,
              })
            ) {
              await new Promise((resolve) => setTimeout(resolve, 25))
            }
          } finally {
            this.replaying = false
          }
        } else {
          throw new Error(`${this.deps.label} cannot resume sessions`)
        }
      } else {
        const res = await this.setup<SetupResponse & { sessionId: string }>('session/new', base)
        this.acpSessionId = res.sessionId
        modes = res.modes
        configOptions = res.configOptions
        models = res.models
      }

      this.emit({ type: 'session.provider-session', providerSessionId: this.acpSessionId })
      const agentOptions = toConfigOptions(configOptions)
      // An agent that lists models outside its config options still gets a model setting.
      if (!agentOptions.some((o) => o.category === 'model')) {
        const fromState = modelOptionFromState(models)
        if (fromState) {
          this.modelState = models
          this.modelValue = String(fromState.value)
        }
      }
      const rest = await this.announceModes(modes, agentOptions)
      const shown = this.withModel(rest)
      if (this.input.textOnly && this.input.model) {
        const model = shown.find((o) => o.category === 'model')
        if (model) await this.sendConfig(model.id, this.input.model)
      }
      if (this.input.textOnly) {
        const reasoning = shown.find(
          (o) =>
            o.type === 'select' &&
            (o.category === 'thought_level' ||
              /^(reasoning[_-]effort|thinking[_-]level|thought[_-]level)$/i.test(o.id)),
        )
        const fast = ['none', 'off', 'minimal', 'low'].find((level) =>
          reasoning?.choices?.some((c) => c.value === level),
        )
        if (reasoning && fast && reasoning.value !== fast) {
          await this.sendConfig(reasoning.id, fast).catch((err) =>
            this.deps.log.debug('Agent kept its default reasoning setting', err),
          )
        }
      }
      if (shown.length > 0) this.emit({ type: 'session.config', options: shown })
      // Settings chosen before the session started (model, thinking level, ...).
      for (const [id, value] of Object.entries(this.input.config ?? {})) {
        try {
          await this.sendConfig(id, value)
        } catch (err) {
          this.deps.log.warn(`could not apply ${id} for ${this.sessionId}`, err)
        }
      }
    } catch (err) {
      this.fail(this.explain(err))
      throw err
    }
  }

  private authMethods: string[] = []

  /** An agent that wants a sign-in says so with a bare auth error; tell the user what to do. */
  private explain(err: unknown): string {
    const message = describeRpcError(err)
    const code = err instanceof JsonRpcError ? err.code : undefined
    if (
      (code === -32000 || /auth|sign.?in|log.?in|credential/i.test(message)) &&
      this.authMethods.length > 0
    ) {
      return `${this.deps.label} needs you to sign in (${this.authMethods.join(' or ')}). Do that with the agent itself, then try again.`
    }
    if (/ended|closed|stopped/i.test(message)) return this.endMessage()
    return message
  }

  /** A session setup request, tried again when the agent's session storage is not ready yet. */
  private async setup<T>(method: string, params: Obj): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.rpc.request<T>(method, params, { timeoutMs: SESSION_TIMEOUT })
      } catch (err) {
        if (!isStorageNotFound(err) || attempt >= STORAGE_RETRIES) throw err
        await new Promise((resolve) => setTimeout(resolve, STORAGE_RETRY_MS))
      }
    }
  }

  /** The settings with the model setting added, for an agent that keeps its models apart. */
  private withModel(options: ConfigOption[]): ConfigOption[] {
    if (!this.modelState || options.some((o) => o.category === 'model')) return options
    const model = modelOptionFromState(this.modelState)
    if (!model) return options
    return [{ ...model, value: this.modelValue ?? model.value }, ...options]
  }

  /**
   * Reports how much the agent asks (its mode option, its modes, or the app's own choice when it
   * has neither) and applies the one the user asked for. Returns the settings that are left.
   */
  private async announceModes(modes: Modes | undefined, options: ConfigOption[]) {
    const setup = approvalSetup(modes, options, this.deps.profile)
    this.modeSource = setup.source
    this.modeOptionId = setup.optionId
    this.modes = setup.modes
    this.mapper.setModes(setup.modes)
    // Started with a flag for a mode: that is the mode it is in, whatever its config file says.
    let current =
      setup.source === 'command' && this.deps.launchedMode ? this.deps.launchedMode : setup.current
    const wanted = this.input.textOnly
      ? ['read-only', 'readonly', 'plan', 'ask', 'default', 'normal']
          .map((id) => setup.modes.find((m) => m.id.toLowerCase() === id)?.id)
          .find(Boolean)
      : this.input.permissionMode
    if (wanted && wanted !== current && setup.modes.some((m) => m.id === wanted)) {
      await this.applyMode(wanted)
      current = wanted
    }
    this.emit({ type: 'session.modes', modes: setup.modes, currentModeId: current })
    return setup.rest
  }

  /**
   * Sends a slash command to the agent as a prompt that is not shown: it is the agent's own way of
   * changing a setting. Its reply is dropped, and no turn is reported.
   */
  private async quietPrompt(text: string) {
    this.quiet = true
    try {
      await this.rpc.request(
        'session/prompt',
        { sessionId: this.acpSessionId, prompt: [{ type: 'text', text }] },
        { timeoutMs: SESSION_TIMEOUT },
      )
    } finally {
      this.quiet = false
    }
  }

  private async applyMode(modeId: string) {
    if (this.modeSource === 'client') this.approveAll = modeId === 'approve-all'
    else if (this.modeSource === 'command') {
      const command = this.deps.profile?.modes.find((m) => m.id === modeId)?.command
      if (this.inflightTurn) throw new Error('Wait for the current turn to finish, then switch.')
      if (command) await this.quietPrompt(command)
    } else if (this.modeSource === 'config' && this.modeOptionId) {
      await this.sendConfig(this.modeOptionId, modeId)
    } else {
      await this.rpc.request('session/set_mode', { sessionId: this.acpSessionId, modeId })
    }
  }

  /** Reports settings; the mode option has its own picker, so it is announced as modes instead. */
  private emitConfig(all: ConfigOption[]) {
    const setup = approvalSetup(undefined, all)
    if (setup.source === 'config') {
      this.modes = setup.modes
      this.emit({ type: 'session.modes', modes: setup.modes, currentModeId: setup.current })
    }
    this.emit({ type: 'session.config', options: setup.rest })
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.closed) throw new Error('session is closed')
    try {
      await this.ready
    } catch {
      return // the start-up failure was already reported as an error event
    }

    const turnId = `turn-${++this.turnCount}`
    this.inflightTurn = turnId
    this.mapper.setTurn(turnId)
    this.emit({ type: 'turn.started' }, turnId)
    // A turn the agent never answers (it hangs, or ignores a cancel) is ended from outside.
    const forced = new Promise<'forced'>((resolve) => (this.endTurn = () => resolve('forced')))
    this.startWatchdog(turnId)

    try {
      const request = this.rpc.request<{ stopReason: string }>('session/prompt', {
        sessionId: this.acpSessionId,
        prompt: [
          { type: 'text', text: input.text },
          ...(await this.imageBlocks(input.attachments)),
        ],
      })
      const res = await Promise.race([request, forced])
      if (res === 'forced') return
      // What the turn used, when the agent says; counted even if the turn was cut short.
      const reported = promptUsage(res)
      if (reported.some((u) => u.costUsd !== undefined)) this.mapper.noteTurnCost()
      for (const event of usageEvents(reported)) this.emit(event, turnId)
      if (this.inflightTurn !== turnId) return
      this.inflightTurn = null
      switch (res.stopReason) {
        case 'end_turn':
          this.emit({ type: 'turn.completed', reason: 'done' }, turnId)
          break
        case 'cancelled':
          this.emit({ type: 'turn.completed', reason: 'cancelled' }, turnId)
          break
        default:
          this.emit(
            { type: 'error', message: `${this.deps.label} stopped: ${res.stopReason}` },
            turnId,
          )
          this.emit({ type: 'turn.completed', reason: 'error' }, turnId)
      }
    } catch (err) {
      // `fail` already reported a dead process; otherwise finish the turn here.
      if (this.inflightTurn !== turnId) return
      this.inflightTurn = null
      this.emit(
        { type: 'error', message: err instanceof Error ? err.message : String(err) },
        turnId,
      )
      this.emit({ type: 'turn.completed', reason: 'error' }, turnId)
    } finally {
      this.stopWatchdog()
      this.endTurn = undefined
    }
  }

  /** Ends the running turn now, whatever the agent does: it is not answering. */
  private forceEnd(turnId: string, reason: 'error' | 'cancelled', message?: string) {
    if (this.inflightTurn !== turnId) return
    this.inflightTurn = null
    this.cancelAllPending()
    if (message) this.emit({ type: 'error', message }, turnId)
    this.emit({ type: 'turn.completed', reason }, turnId)
    this.endTurn?.()
  }

  private startWatchdog(turnId: string) {
    this.lastProgressAt = Date.now()
    this.stopWatchdog()
    const timing = idleTiming()
    this.watchdog = setInterval(() => {
      const idleMs = Date.now() - this.lastProgressAt
      const decision = evaluateIdleTick({
        turnActive: this.inflightTurn === turnId,
        awaitingUser: this.pending.size + this.questionWaiters.size > 0,
        idleMs,
        timeoutMs: timing.timeoutMs,
      })
      if (decision === 'stop') this.stopWatchdog()
      else if (decision === 'touch') this.lastProgressAt = Date.now()
      else if (decision === 'timeout') {
        this.stopWatchdog()
        void this.giveUpOnTurn(turnId, idleMs, timing.graceMs)
      }
    }, timing.checkMs)
    this.watchdog.unref?.()
  }

  private stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  /** The agent has been silent too long: ask it to cancel, and end the turn if it does not. */
  private async giveUpOnTurn(turnId: string, idleMs: number, graceMs: number) {
    this.deps.log.warn(
      `${this.deps.label} was silent for ${Math.round(idleMs / 1000)}s; cancelling`,
    )
    if (this.acpSessionId) this.rpc.notify('session/cancel', { sessionId: this.acpSessionId })
    await new Promise((resolve) => setTimeout(resolve, graceMs))
    const minutes = Math.max(1, Math.round(idleMs / 60_000))
    this.forceEnd(
      turnId,
      'error',
      `${this.deps.label} stopped responding for ${minutes} minute${minutes === 1 ? '' : 's'}, so the turn was ended.`,
    )
  }

  /** Pictures go in as image blocks when the agent takes them; every file is also named in the text. */
  private async imageBlocks(files: string[] | undefined): Promise<Obj[]> {
    if (!this.canSendImages || !files) return []
    const blocks: Obj[] = []
    for (const file of files) {
      const mimeType = IMAGE_TYPES[path.extname(file).toLowerCase()]
      if (!mimeType) continue
      try {
        if ((await stat(file)).size > MAX_IMAGE_BYTES) continue
        blocks.push({ type: 'image', mimeType, data: (await readFile(file)).toString('base64') })
      } catch {
        // The file path in the text still lets the agent read it by itself.
      }
    }
    return blocks
  }

  /** Changes one of the settings the agent offers (its model, thinking level, ...). */
  async setConfigOption(optionId: string, value: string | boolean) {
    await this.ready
    await this.sendConfig(optionId, value)
  }

  private async sendConfig(optionId: string, value: string | boolean) {
    if (this.modelState && optionId === 'model' && typeof value === 'string') {
      await this.rpc.request(
        'session/set_model',
        { sessionId: this.acpSessionId, modelId: value },
        { timeoutMs: SESSION_TIMEOUT },
      )
      this.modelValue = value
      this.emit({ type: 'session.config', options: this.withModel([]) })
      return
    }
    const res = await this.rpc.request<{ configOptions?: SessionConfigOption[] }>(
      'session/set_config_option',
      {
        sessionId: this.acpSessionId,
        configId: optionId,
        ...(typeof value === 'boolean' ? { type: 'boolean', value } : { value }),
      },
      { timeoutMs: SESSION_TIMEOUT },
    )
    if (res.configOptions) this.emitConfig(toConfigOptions(res.configOptions))
  }

  async interrupt() {
    this.cancelAllPending()
    if (this.acpSessionId) this.rpc.notify('session/cancel', { sessionId: this.acpSessionId })
    // An agent that ignores the cancel must not leave the turn stuck.
    const turnId = this.inflightTurn
    if (turnId) {
      const timer = setTimeout(() => this.forceEnd(turnId, 'cancelled'), idleTiming().graceMs)
      timer.unref?.()
    }
  }

  async setPermissionMode(modeId: string) {
    await this.ready
    await this.applyMode(modeId)
    // Not every agent follows a switch with `current_mode_update`; report it ourselves.
    this.emit({ type: 'session.modes', modes: this.modes, currentModeId: modeId })
  }

  async respondToApproval(requestId: string, optionId: string) {
    const answer = this.pending.get(requestId)
    if (!answer) throw new Error(`No pending approval ${requestId}`)
    this.pending.delete(requestId)
    answer(optionId)
    this.emit({ type: 'approval.resolved', requestId, optionId }, this.currentTurn())
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.cancelAllPending()
    this.terminals.releaseAll()
    if (this.input.textOnly && this.acpSessionId) {
      if (this.inflightTurn) this.rpc.notify('session/cancel', { sessionId: this.acpSessionId })
      if (this.canCloseSession) {
        await this.rpc
          .request('session/close', { sessionId: this.acpSessionId }, { timeoutMs: 1500 })
          .catch(() => {})
      }
    }
    this.rpc.close()
    this.queue.close()
  }

  private currentTurn() {
    return `turn-${this.turnCount}`
  }

  private onNotification(method: string, params: unknown) {
    if (method !== 'session/update') return
    if (this.replaying) {
      this.lastReplayAt = Date.now()
      return
    }
    const p = params as { sessionId?: string; update?: SessionUpdate }
    if (p.sessionId !== this.acpSessionId || !p.update) return
    if (
      this.quiet &&
      (p.update.sessionUpdate === 'agent_message_chunk' ||
        p.update.sessionUpdate === 'agent_thought_chunk')
    )
      return
    if (isProgress(p.update.sessionUpdate)) this.lastProgressAt = Date.now()
    for (const event of this.mapper.map(p.update)) {
      if (event.type === 'session.config' && this.modelState) {
        this.queue.push({ ...event, options: this.withModel(event.options) })
      } else this.queue.push(event)
    }
  }

  private async onClientRequest(method: string, params: unknown): Promise<unknown> {
    if (this.input.textOnly) {
      const message =
        'The agent requested a tool or question while generating text. Try another agent.'
      this.emit({ type: 'error', message }, this.currentTurn())
      if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
      if (method === 'elicitation/create') return { action: 'decline' }
      if (GROK_QUESTION_METHODS.includes(method) || GROK_PLAN_METHODS.includes(method))
        return { outcome: 'cancelled' }
      throw new JsonRpcError(-32601, message)
    }
    const p = (params ?? {}) as Obj
    switch (method) {
      case 'session/request_permission':
        return this.askPermission(p as unknown as RequestPermissionRequest)

      case 'elicitation/create': {
        const asked = elicitationQuestions(p)
        // A form this cannot show (a link to open, an odd mode) is declined, not left waiting.
        return asked ? this.askQuestions(asked) : { action: 'decline' }
      }

      case 'fs/read_text_file': {
        const file = this.absolute(p.path)
        const text = await readFile(file, 'utf8')
        const line = typeof p.line === 'number' ? Math.max(1, p.line) : 1
        const limit = typeof p.limit === 'number' ? p.limit : undefined
        if (line === 1 && limit === undefined) return { content: text }
        const lines = text.split('\n').slice(line - 1)
        return { content: (limit === undefined ? lines : lines.slice(0, limit)).join('\n') }
      }
      case 'fs/write_text_file': {
        const file = this.absolute(p.path)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, String(p.content ?? ''), 'utf8')
        return {}
      }

      case 'terminal/create':
        return this.terminals.create({
          command: String(p.command),
          args: p.args as string[] | undefined,
          env: p.env as { name: string; value: string }[] | undefined,
          cwd: p.cwd as string | null | undefined,
          outputByteLimit: p.outputByteLimit as number | null | undefined,
        })
      case 'terminal/output':
        return this.terminals.output(String(p.terminalId))
      case 'terminal/wait_for_exit':
        return this.terminals.waitForExit(String(p.terminalId))
      case 'terminal/kill':
        this.terminals.kill(String(p.terminalId))
        return {}
      case 'terminal/release':
        this.terminals.release(String(p.terminalId))
        return {}

      default:
        if (GROK_QUESTION_METHODS.includes(method)) {
          const asked = grokQuestions(p)
          return asked ? this.askQuestions(asked) : { outcome: 'cancelled' }
        }
        if (GROK_PLAN_METHODS.includes(method)) return this.askPlan(grokPlan(p))
        throw new JsonRpcError(-32601, `Method not found: ${method}`)
    }
  }

  /** Shows the agent's questions and returns its reply once the user answers (or dismisses them). */
  private askQuestions<R>(asked: AskedQuestions<R>): Promise<R> {
    const requestId = `req-${++this.approvalCount}`
    return new Promise((resolve) => {
      this.questionWaiters.set(requestId, (answers) => resolve(asked.respond(answers)))
      this.emit(
        { type: 'question.requested', requestId, questions: asked.specs },
        this.currentTurn(),
      )
    })
  }

  async answerQuestion(requestId: string, answers?: Record<string, string[]>) {
    const waiter = this.questionWaiters.get(requestId)
    if (!waiter) throw new Error(`No pending question ${requestId}`)
    this.questionWaiters.delete(requestId)
    waiter(answers)
    this.emit({ type: 'question.resolved', requestId, answers }, this.currentTurn())
  }

  /** Grok hands over a finished plan for the user to approve before it builds anything. */
  private askPlan(plan: string | undefined): Promise<unknown> {
    if (!plan) return Promise.resolve({ outcome: 'cancelled', feedback: KEEP_PLANNING_FEEDBACK })
    const requestId = `req-${++this.approvalCount}`
    return new Promise((resolve) => {
      this.pending.set(requestId, (optionId) =>
        resolve(
          optionId === 'approve'
            ? { outcome: 'approved' }
            : { outcome: 'cancelled', feedback: KEEP_PLANNING_FEEDBACK },
        ),
      )
      this.emit(
        {
          type: 'approval.requested',
          requestId,
          title: 'Plan ready for review',
          plan,
          options: [
            { id: 'approve', label: 'Approve and build', kind: 'allow' },
            { id: 'revise', label: 'Keep planning', kind: 'deny' },
          ],
        },
        this.currentTurn(),
      )
    })
  }

  private absolute(value: unknown): string {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new JsonRpcError(-32602, 'path must be absolute')
    }
    return value
  }

  /** Shows the agent's own options and returns the one the user picks, by its own id. */
  private askPermission(req: RequestPermissionRequest): Promise<unknown> {
    // Approving everything: the protocol lets a client answer on the user's behalf.
    // The host's own tools (see isHostTool) go through; they ask the user themselves if needed.
    const own = (this.input.mcpServers ?? []).map((m) => m.name)
    if (this.approveAll || isHostTool(req.toolCall, own)) {
      const allow = allowOption(req.options)
      if (allow)
        return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
    }
    const requestId = `req-${++this.approvalCount}`
    const tool = req.toolCall
    if (tool.toolCallId) this.mapper.noteApproval(tool.toolCallId)
    const raw = (tool.rawInput ?? {}) as Obj
    // Two or more "allow" choices of one kind make this a chooser (which branch, which option):
    // what is being chosen between is in the tool call's content, not in a command.
    const chooser = isChooser(req.options)
    const detail =
      (chooser ? contentText(tool.content) : undefined) ||
      (typeof raw.command === 'string' && raw.command) ||
      (typeof raw.file_path === 'string' && raw.file_path) ||
      tool.locations?.[0]?.path ||
      undefined

    return new Promise((resolve) => {
      this.pending.set(requestId, (optionId) =>
        resolve(
          optionId === null
            ? { outcome: { outcome: 'cancelled' } }
            : { outcome: { outcome: 'selected', optionId } },
        ),
      )
      this.emit(
        {
          type: 'approval.requested',
          requestId,
          toolId: tool.toolCallId || undefined,
          title: tool.title ?? 'Permission requested',
          detail: detail || undefined,
          options: req.options.map((o: PermissionOption) => ({
            id: o.optionId,
            label: o.name,
            kind: o.kind.startsWith('allow') ? ('allow' as const) : ('deny' as const),
          })),
        },
        this.currentTurn(),
      )
    })
  }

  /** Answers every open request with the protocol's "cancelled" outcome. */
  private cancelAllPending() {
    for (const [requestId, waiter] of this.questionWaiters) {
      waiter(undefined)
      this.emit({ type: 'question.resolved', requestId }, this.currentTurn())
    }
    this.questionWaiters.clear()
    for (const [requestId, answer] of this.pending) {
      answer(null)
      this.emit({ type: 'approval.resolved', requestId, optionId: 'cancelled' }, this.currentTurn())
    }
    this.pending.clear()
  }

  private fail(message: string) {
    if (this.closed) return
    this.closed = true
    this.stopWatchdog()
    this.cancelAllPending()
    this.terminals.releaseAll()
    this.emit({ type: 'error', message }, this.currentTurn())
    if (this.inflightTurn) {
      this.emit({ type: 'turn.completed', reason: 'error' }, this.inflightTurn)
      this.inflightTurn = null
    }
    this.queue.close()
    this.rpc.close()
  }
}
