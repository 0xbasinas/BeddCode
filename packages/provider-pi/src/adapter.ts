import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ModelOption, ProviderCapabilities, ProviderInstance } from '@beddcode/contracts'
import type {
  ProviderAdapter,
  ProviderSession,
  PromptInput,
  StartSessionInput,
} from '@beddcode/provider-core'
import {
  createAsyncQueue,
  createLogger,
  resolveExecutable,
  runCommand,
  spawnProcess,
  type Logger,
  type SupervisedProcess,
  type SupervisorClient,
} from '@beddcode/shared'
import { generateSessionText } from '@beddcode/provider-core'
import { PiEventMapper } from './mapper.ts'

export const PI_INSTANCE_ID = 'pi'
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const MODES = [
  {
    id: 'default',
    label: 'Pi default',
    description:
      'Uses the tools enabled in Pi’s configuration. Pi does not request per-tool approval in RPC mode.',
  },
  {
    id: 'read-only',
    label: 'Read only',
    description:
      'Runs Pi with read, search, and list tools enabled. Choose this before starting; it cannot be changed mid-session.',
  },
]
export const piCapabilities: ProviderCapabilities = {
  textGeneration: true,
  resume: true,
  fork: false,
  steer: true,
  planMode: false,
  imageInput: true,
  usage: true,
  questions: false,
  commands: true,
  history: true,
  mcp: false,
  permissionModes: MODES,
  efforts: LEVELS,
}

export type PiSpawn = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams
export interface PiAdapterOptions {
  executablePath?: string
  sessionDir?: string
  instanceId?: string
  label?: string
  log?: Logger
  run?: typeof runCommand
  spawnFn?: PiSpawn
  /** Keeps Pi running across host restarts (see docs/agent-supervisor.md). */
  supervisor?: SupervisorClient
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parsePiModels(raw: unknown): ModelOption[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((m): ModelOption[] => {
    if (!isObj(m) || typeof m.id !== 'string' || typeof m.provider !== 'string') return []
    const id = `${m.provider}/${m.id}`
    const name = typeof m.name === 'string' ? m.name : id
    const reasoning = m.reasoning === true
    return [{ id, label: name, efforts: reasoning ? LEVELS : ['off'] }]
  })
}

/** Parses the human-readable table emitted by `pi --list-models`. */
export function parsePiModelList(output: string): ModelOption[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const headerIndex = lines.findIndex(
    (line) => /provider/i.test(line) && /model/i.test(line) && /context/i.test(line),
  )
  const rows = headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines
  const models: ModelOption[] = []
  for (const line of rows) {
    const columns = line.split(/\s+/)
    if (columns.length < 2 || /^(provider|─+|[-=]+)$/i.test(columns[0]!)) continue
    const [provider, modelId] = columns
    if (!provider || !modelId || /^(context|model)$/i.test(modelId) || !/^[\w.-]+$/.test(provider))
      continue
    const reasoning = columns.some((column) => /^yes$/i.test(column))
    const id = `${provider}/${modelId}`
    models.push({ id, label: modelId, efforts: reasoning ? LEVELS : ['off'] })
  }
  return models
}

export function createPiAdapter(options: PiAdapterOptions = {}): ProviderAdapter {
  const log = options.log ?? createLogger('pi')
  const run = options.run ?? runCommand
  const instanceId = options.instanceId ?? PI_INSTANCE_ID
  const executable = () =>
    options.executablePath ? resolveExecutable(options.executablePath) : resolveExecutable('pi')
  let capabilities = piCapabilities
  async function detect(): Promise<ProviderInstance> {
    const base = { id: instanceId, kind: 'pi' as const, label: options.label ?? 'Pi', capabilities }
    const exe = executable()
    if (!exe) return { ...base, status: 'not-installed' }
    let version: string | undefined
    let status: ProviderInstance['status'] = 'ready'
    try {
      const v = await run(exe, ['--version'], { env: process.env, timeoutMs: 15_000 })
      if (v.code !== 0) throw new Error(v.stderr || v.stdout || 'Pi version check failed')
      version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0]
      const listed = await run(exe, ['--list-models'], { env: process.env, timeoutMs: 20_000 })
      if (listed.code === 0) {
        const models = parsePiModelList(listed.stdout)
        capabilities = { ...piCapabilities, models: models.length ? models : undefined }
        if (
          !models.length &&
          /sign.?in|auth|credential|api key/i.test(`${listed.stdout}\n${listed.stderr}`)
        )
          status = 'needs-sign-in'
      }
    } catch (err) {
      log.warn('Pi detection failed', err)
      status = 'error'
    }
    return { ...base, capabilities, status, version }
  }
  const start = async (input: StartSessionInput) => {
    const exe = executable()
    if (!exe)
      throw new Error(
        'Pi is not installed on this host. Install it from https://pi.dev and restart BeddCode.',
      )
    const supervisor = input.textOnly ? undefined : options.supervisor
    const attached = input.reattach
      ? await supervisor?.attach(input.sessionId).catch(() => undefined)
      : undefined
    return new PiSession(input, {
      exe,
      sessionDir: options.sessionDir,
      log,
      spawnFn: options.spawnFn,
      models: capabilities.models ?? [],
      supervisor,
      attached,
    })
  }
  return {
    kind: 'pi',
    detect: async () => [await detect()],
    capabilities: () => capabilities,
    startSession: async (_id, input) => start(input),
    async listHistory(_id, cwd) {
      const dir = options.sessionDir
      if (!dir) return []
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const sessions = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
          .map(async (entry) => {
            const file = path.join(dir, entry.name)
            try {
              const raw = await readFile(file, 'utf8')
              const lines = raw
                .split(/\r?\n/)
                .filter(Boolean)
                .map((line) => JSON.parse(line) as Obj)
              const header = lines[0]
              if (!header || header.type !== 'session' || (cwd && header.cwd !== cwd))
                return undefined
              const named = lines.findLast(
                (line) => line.type === 'session_info' && typeof line.name === 'string',
              )
              const firstUser = lines.find(
                (line) =>
                  line.type === 'message' && isObj(line.message) && line.message.role === 'user',
              )
              const firstText =
                firstUser && isObj(firstUser.message)
                  ? piContentText(firstUser.message.content)
                  : undefined
              const info = await stat(file)
              return {
                id: file,
                title: str(named?.name) ?? firstText?.slice(0, 100) ?? 'Pi session',
                updatedAt: info.mtimeMs,
                cwd: str(header.cwd),
              }
            } catch {
              return undefined
            }
          }),
      )
      return sessions
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    },
    async readHistory(_id, providerSessionId, cwd) {
      const raw = await readFile(providerSessionId, 'utf8')
      const lines = raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Obj)
      const header = lines[0]
      if (!header || header.type !== 'session' || (cwd && header.cwd !== cwd))
        throw new Error('Pi session does not belong to this folder')
      const byId = new Map(
        lines
          .slice(1)
          .filter((entry) => typeof entry.id === 'string')
          .map((entry) => [entry.id as string, entry]),
      )
      const ordered: Obj[] = []
      let cursor = [...byId.keys()].at(-1)
      const seen = new Set<string>()
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor)
        const entry = byId.get(cursor)
        if (!entry) break
        ordered.unshift(entry)
        cursor = str(entry.parentId)
      }
      const turns: { user: string; assistant: string }[] = []
      for (const entry of ordered) {
        if (entry.type !== 'message' || !isObj(entry.message)) continue
        const role = entry.message.role
        const text = piContentText(entry.message.content)
        if (!text) continue
        if (role === 'user') turns.push({ user: text, assistant: '' })
        else if (role === 'assistant' && turns.length)
          turns[turns.length - 1]!.assistant +=
            (turns[turns.length - 1]!.assistant ? '\n' : '') + text
      }
      return turns.filter((turn) => turn.user)
    },
    async generateText(input) {
      const session = await start({
        sessionId: randomUUID(),
        cwd: input.cwd,
        model: input.model,
        effort: input.effort,
        textOnly: true,
      })
      return generateSessionText(session, input.prompt)
    },
  }
}

export interface PiDeps {
  exe: string
  /** Put before Pi's own arguments, for a Pi that is started through an interpreter or wrapper. */
  exeArgs?: string[]
  sessionDir?: string
  log: Logger
  spawnFn?: PiSpawn
  models: ModelOption[]
  /** Keeps Pi running across host restarts (see docs/agent-supervisor.md). */
  supervisor?: SupervisorClient
  /** A Pi a previous host left running, to carry on with. */
  attached?: SupervisedProcess
}
type RpcPending = {
  resolve(value: Obj): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
type Draft<E = import('@beddcode/contracts').SessionEvent> = E extends unknown
  ? Omit<E, 'sessionId' | 'at' | 'turnId'>
  : never

export class PiSession implements ProviderSession {
  readonly sessionId: string
  private readonly queue = createAsyncQueue<import('@beddcode/contracts').SessionEvent>()
  private readonly mapper: PiEventMapper
  private child?: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, RpcPending>()
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private serial = 0
  private turn = 0
  private running = false
  private closed = false
  private providerSessionId?: string
  private model?: string
  private effort?: string
  private modelRows: ModelOption[]
  /** Pi models without image input must receive an attachment path, never an image block. */
  private supervised: SupervisedProcess | undefined
  private readonly imageModels = new Set<string>()
  /** This session took over a Pi that was already running (and maybe mid-turn). */
  readonly reattached: boolean

  constructor(
    private readonly input: StartSessionInput,
    private readonly deps: PiDeps,
  ) {
    this.sessionId = input.sessionId
    this.mapper = new PiEventMapper(input.sessionId)
    this.model = input.model
    this.effort = input.effort
    this.modelRows = deps.models
    this.reattached = deps.attached?.meta !== undefined
    const meta = deps.attached?.meta
    if (meta) {
      // Pick up where the previous host stopped: same turn numbering, same turn, same settings.
      this.turn = Number(meta.turn) || 0
      this.running = meta.running === true
      if (this.running) this.mapper.setTurn(`turn-${this.turn}`)
      this.providerSessionId =
        typeof meta.providerSessionId === 'string' ? meta.providerSessionId : undefined
      this.model = typeof meta.model === 'string' ? meta.model : this.model
      this.effort = typeof meta.effort === 'string' ? meta.effort : this.effort
      // Answers meant for the previous host's requests must not match this host's.
      this.serial = 1_000_000 + (Date.now() % 1_000_000_000)
      void this.ensureStarted().catch((err: unknown) => {
        this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    }
  }
  get events() {
    return this.queue
  }
  private emit(draft: Draft, turnId?: string) {
    this.queue.push({
      ...draft,
      sessionId: this.sessionId,
      turnId,
      at: Date.now(),
    } as import('@beddcode/contracts').SessionEvent)
  }
  private async ensureStarted() {
    if (this.child) return
    const args = [
      ...(this.deps.exeArgs ?? []),
      '--mode',
      'rpc',
      ...(this.input.textOnly
        ? ['--no-session', '--tools', 'read,grep,find,ls']
        : [
            '--session-dir',
            this.deps.sessionDir ?? path.join(this.input.cwd, '.pi', 'beddcode-sessions'),
          ]),
      ...(this.input.permissionMode === 'read-only' ? ['--tools', 'read,grep,find,ls'] : []),
      ...(this.input.model ? ['--model', this.input.model] : []),
    ]
    const launch = this.deps.spawnFn ?? ((f, a, o) => spawnProcess(f, a, o) as never)
    if (this.deps.sessionDir && !this.input.textOnly)
      await mkdir(this.deps.sessionDir, { recursive: true })
    const child = this.deps.attached
      ? (this.deps.attached as never as ChildProcessWithoutNullStreams)
      : this.deps.supervisor
        ? (this.deps.supervisor.spawn(
            this.sessionId,
            {
              command: this.deps.exe,
              args,
              cwd: this.input.cwd,
              env: { ...process.env },
              protocol: 'jsonrpc',
            },
            {},
          ) as never as ChildProcessWithoutNullStreams)
        : launch(this.deps.exe, args, { cwd: this.input.cwd, env: { ...process.env } })
    this.child = child
    this.supervised =
      this.deps.attached ??
      (this.deps.supervisor ? (child as never as SupervisedProcess) : undefined)
    if (this.supervised) {
      this.supervised.ackGate = () => this.queue.idle
      this.supervised.ackDelayMs = 0 // each line is handled as it arrives
    }
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => this.readChunk(chunk))
    child.stderr.on('data', (chunk: Buffer) =>
      this.deps.log.debug(`Pi: ${chunk.toString('utf8').slice(-1000)}`),
    )
    child.once('error', (err) => this.failAll(err))
    child.once('close', (code) =>
      this.failAll(new Error(`Pi exited${code === null ? '' : ` with code ${code}`}`)),
    )
    try {
      // A Pi that is still running has its session open already.
      if (this.input.resumeId && !this.reattached)
        await this.rpc('switch_session', { sessionPath: this.input.resumeId })
      else await this.rpc('get_state')
      const state = await this.rpc('get_state')
      const file = isObj(state.data) ? state.data.sessionFile : undefined
      if (typeof file === 'string' && !this.input.textOnly) this.adopt(file)
      const models = await this.rpc('get_available_models').catch(() => undefined)
      const rawModelRows =
        isObj(models?.data) && Array.isArray(models.data.models)
          ? models.data.models.filter(isObj)
          : []
      const modelRows: ModelOption[] = rawModelRows.length
        ? parsePiModels(rawModelRows)
        : this.deps.models
      this.modelRows = modelRows
      this.imageModels.clear()
      for (const row of rawModelRows) {
        if (typeof row.provider !== 'string' || typeof row.id !== 'string') continue
        if (Array.isArray(row.input) && row.input.includes('image'))
          this.imageModels.add(`${row.provider}/${row.id}`)
      }
      const stateModel =
        isObj(state.data) &&
        isObj(state.data.model) &&
        str(state.data.model.provider) &&
        str(state.data.model.id)
          ? `${str(state.data.model.provider)}/${str(state.data.model.id)}`
          : undefined
      const selectedModel = this.model ?? stateModel ?? modelRows[0]?.id
      if (selectedModel) this.model = selectedModel
      if (!this.effort && isObj(state.data)) this.effort = str(state.data.thinkingLevel)
      const levels = await this.getThinkingLevels().catch(() => ['off'])
      this.emit({
        type: 'session.config',
        options: [
          ...(modelRows.length
            ? [
                {
                  id: 'model',
                  name: 'Model',
                  category: 'model',
                  type: 'select' as const,
                  value: selectedModel ?? modelRows[0]!.id,
                  choices: modelRows.map((m) => ({ value: m.id, name: m.label })),
                },
              ]
            : []),
          {
            id: 'thinkingLevel',
            name: 'Thinking level',
            category: 'thought_level',
            type: 'select',
            value:
              this.effort && levels.includes(this.effort)
                ? this.effort
                : levels.includes('medium')
                  ? 'medium'
                  : (levels[0] ?? 'off'),
            choices: levels.map((value) => ({ value, name: value })),
          },
        ],
      })
      this.emit({
        type: 'session.modes',
        modes: MODES,
        currentModeId: this.input.permissionMode === 'read-only' ? 'read-only' : 'default',
      })
      if (this.model) await this.setModel(this.model, this.effort)
      void this.announceCommands()
    } catch (error) {
      await this.close()
      throw error
    }
  }
  private readChunk(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk)
    let n: number
    while ((n = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, n)
      this.buffer = this.buffer.slice(n + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.readLine(line)
    }
  }
  private readLine(line: string) {
    if (!line.trim()) return
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      this.deps.log.debug(`ignored invalid Pi RPC line: ${line.slice(0, 100)}`)
      return
    }
    if (!isObj(event)) return
    if (event.type === 'response' && typeof event.id === 'string') {
      const p = this.pending.get(event.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(event.id)
      if (event.success === false)
        p.reject(new Error(str(event.error) ?? `Pi ${String(event.command)} failed`))
      else p.resolve(event)
      return
    }
    if (event.type === 'extension_ui_request' && typeof event.id === 'string') {
      this.write({ type: 'extension_ui_response', id: event.id, cancelled: true })
      return
    }
    if (event.type === 'agent_start') {
      this.running = true
      const turnId = `turn-${++this.turn}`
      this.syncMeta()
      this.mapper.setTurn(turnId)
      this.emit({ type: 'turn.started' }, turnId)
      return
    }
    if (event.type === 'agent_end') {
      const turnId = `turn-${this.turn || 1}`
      for (const e of this.mapper.abandonTools()) this.queue.push(e)
      const messages = Array.isArray(event.messages) ? event.messages : []
      const assistant = messages
        .filter(isObj)
        .filter((m) => isObj(m.usage))
        .at(-1)
      if (assistant && isObj(assistant.usage)) {
        const u = assistant.usage
        this.emit(
          {
            type: 'session.usage',
            model: str(assistant.model),
            inputTokens: num(u.input),
            outputTokens: num(u.output),
            cacheReadTokens: num(u.cacheRead),
            cacheWriteTokens: num(u.cacheWrite),
            costUsd: isObj(u.cost) && typeof u.cost.total === 'number' ? u.cost.total : undefined,
          },
          turnId,
        )
      }
      const last = messages.filter(isObj).at(-1)
      this.emit(
        {
          type: 'turn.completed',
          reason:
            last?.stopReason === 'error'
              ? 'error'
              : last?.stopReason === 'aborted'
                ? 'cancelled'
                : 'done',
        },
        turnId,
      )
      this.running = false
      this.syncMeta()
      void this.refreshState().then(() => this.refreshUsage())
      return
    }
    if (event.type === 'session_start' || event.type === 'session_switch') {
      void this.refreshState()
      return
    }
    if (event.type === 'model_changed' && isObj(event.model)) {
      const provider = str(event.model.provider)
      const id = str(event.model.id)
      if (provider && id) this.model = `${provider}/${id}`
      this.effort = str(event.thinkingLevel) ?? this.effort
      this.emit({ type: 'session.model', model: this.model, effort: this.effort })
      void this.getThinkingLevels()
        .then((levels) => this.emitConfig(this.modelRows, levels))
        .catch(() => undefined)
      return
    }
    if (event.type === 'thinking_level_changed') {
      this.effort = str(event.level) ?? this.effort
      this.emit({ type: 'session.model', model: this.model, effort: this.effort })
      void this.getThinkingLevels()
        .then((levels) => this.emitConfig(this.modelRows, levels))
        .catch(() => undefined)
      return
    }
    for (const mapped of this.mapper.map(event)) this.queue.push(mapped)
  }
  private async refreshState() {
    if (this.closed) return
    try {
      const s = await this.rpc('get_state')
      if (!isObj(s.data)) return
      if (typeof s.data.sessionFile === 'string') this.adopt(s.data.sessionFile)
      const modelState = isObj(s.data.model) ? s.data.model : undefined
      const provider = str(modelState?.provider)
      const id = str(modelState?.id)
      const model = provider && id ? `${provider}/${id}` : this.model
      const effort = str(s.data.thinkingLevel) ?? this.effort
      if (model !== this.model || effort !== this.effort) {
        this.model = model
        this.effort = effort
        this.emit({ type: 'session.model', model, effort })
        void this.getThinkingLevels()
          .then((levels) => this.emitConfig(this.modelRows, levels))
          .catch(() => undefined)
      }
    } catch {
      /* process may have exited */
    }
  }
  private adopt(file: string) {
    if (this.providerSessionId === file) return
    this.providerSessionId = file
    this.syncMeta()
    this.emit({ type: 'session.provider-session', providerSessionId: file })
  }
  private write(value: Obj) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Pi RPC process is not running')
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }
  private rpc(command: string, params: Obj = {}): Promise<Obj> {
    const id = `bedd-${++this.serial}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi ${command} timed out`))
      }, 30_000)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ ...params, id, type: command })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
  private failAll(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
  }
  private async announceCommands() {
    try {
      const response = await this.rpc('get_commands')
      const data = isObj(response.data) ? response.data : {}
      const commands = Array.isArray(data.commands)
        ? data.commands.flatMap((c) =>
            isObj(c) && typeof c.name === 'string'
              ? [
                  {
                    name: c.name,
                    description: str(c.description),
                    kind: c.source === 'skill' ? ('skill' as const) : ('command' as const),
                  },
                ]
              : [],
          )
        : []
      if (commands.length) this.emit({ type: 'session.commands', commands })
    } catch {
      /* older Pi versions may not support command discovery */
    }
  }
  private async refreshUsage() {
    try {
      const r = await this.rpc('get_session_stats')
      const data = isObj(r.data) ? r.data : {}
      const tokens = isObj(data.tokens) ? data.tokens : {}
      this.emit({
        type: 'session.usage',
        inputTokens: num(tokens.input),
        outputTokens: num(tokens.output),
        cacheReadTokens: num(tokens.cacheRead),
        cacheWriteTokens: num(tokens.cacheWrite),
        costUsd: typeof data.cost === 'number' ? data.cost : undefined,
      })
    } catch {
      /* stats are supplementary */
    }
  }
  private async getThinkingLevels(): Promise<string[]> {
    const response = await this.rpc('get_available_thinking_levels')
    const data = isObj(response.data) ? response.data : {}
    return Array.isArray(data.levels)
      ? data.levels.filter((level): level is string => typeof level === 'string')
      : ['off']
  }
  private emitConfig(modelRows = this.modelRows, levels: string[] = ['off']) {
    this.emit({
      type: 'session.config',
      options: [
        ...(modelRows.length
          ? [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select' as const,
                value: this.model ?? modelRows[0]!.id,
                choices: modelRows.map((m) => ({ value: m.id, name: m.label })),
              },
            ]
          : []),
        {
          id: 'thinkingLevel',
          name: 'Thinking level',
          category: 'thought_level',
          type: 'select',
          value:
            this.effort && levels.includes(this.effort)
              ? this.effort
              : levels.includes('medium')
                ? 'medium'
                : (levels[0] ?? 'off'),
          choices: levels.map((value) => ({ value, name: value })),
        },
      ],
    })
  }
  async prompt(input: PromptInput) {
    if (this.closed) throw new Error('session is closed')
    if (this.running) {
      await this.rpc('prompt', {
        ...(await this.messagePayload(input)),
        streamingBehavior: 'steer',
      })
      return
    }
    await this.ensureStarted()
    // Startup events can be immediate; completion is driven by agent_end.
    await this.rpc('prompt', await this.messagePayload(input))
  }
  private async messagePayload(input: PromptInput): Promise<Obj> {
    const images: Obj[] = []
    if (!this.input.textOnly)
      for (const file of input.attachments ?? []) {
        const ext = path.extname(file).toLowerCase()
        const mimeType = IMAGE_TYPES[ext]
        if (!mimeType || !this.imageModels.has(this.model ?? '')) continue
        try {
          const { readFile, stat } = await import('node:fs/promises')
          if ((await stat(file)).size <= MAX_IMAGE_BYTES)
            images.push({
              type: 'image',
              mimeType,
              data: (await readFile(file)).toString('base64'),
            })
        } catch {
          /* attachment name remains in text */
        }
      }
    const message = input.attachments?.length
      ? `${input.text}\n\nAttached files:\n${input.attachments.join('\n')}`
      : input.text
    return { message, ...(images.length ? { images } : {}) }
  }
  async steer(input: PromptInput) {
    await this.ensureStarted()
    await this.rpc('steer', await this.messagePayload(input))
  }
  async interrupt() {
    if (this.child && this.running) await this.rpc('abort')
  }
  async setPermissionMode(modeId: string) {
    if (modeId !== 'default' && modeId !== 'read-only')
      throw new Error(`Unknown Pi permission mode: ${modeId}`)
    if (modeId === (this.input.permissionMode === 'read-only' ? 'read-only' : 'default')) return
    throw new Error(
      'Pi permission mode is selected when the session starts; create a new session to change it.',
    )
  }
  async setModel(model: string | undefined, effort: string | undefined) {
    if (!this.child) {
      this.model = model
      this.effort = effort
      return
    }
    if (model) {
      const [provider, ...rest] = model.split('/')
      await this.rpc('set_model', { provider, modelId: rest.join('/') })
    }
    const levels = await this.getThinkingLevels().catch(() => ['off'])
    const nextEffort =
      effort && levels.includes(effort) ? effort : levels.includes('medium') ? 'medium' : levels[0]
    if (nextEffort) await this.rpc('set_thinking_level', { level: nextEffort })
    this.model = model
    this.effort = nextEffort
    this.emitConfig(this.modelRows, levels)
    this.emit({ type: 'session.model', model, effort: nextEffort })
  }
  async setConfigOption(optionId: string, value: string | boolean) {
    if (optionId === 'model' && typeof value === 'string') return this.setModel(value, this.effort)
    if (optionId === 'thinkingLevel' && typeof value === 'string') {
      await this.ensureStarted()
      const levels = await this.getThinkingLevels()
      if (!levels.includes(value))
        throw new Error(`Pi thinking level ${value} is not available for the selected model`)
      await this.rpc('set_thinking_level', { level: value })
      this.effort = value
      this.emit({ type: 'session.model', model: this.model, effort: value })
      this.emitConfig(this.modelRows, levels)
      return
    }
    throw new Error(`Unknown Pi setting: ${optionId}`)
  }
  async respondToApproval(requestId: string) {
    throw new Error(`Pi does not have pending approval ${requestId}`)
  }
  /** What a later host needs to know to pick this Pi up. */
  private syncMeta() {
    this.supervised?.setMeta({
      turn: this.turn,
      running: this.running,
      active: this.running,
      providerSessionId: this.providerSessionId,
      model: this.model,
      effort: this.effort,
    })
  }
  /** The host is stopping but Pi is to keep running (see docs/agent-supervisor.md). */
  async detach() {
    if (this.closed) return
    this.closed = true
    this.syncMeta()
    this.supervised?.detach()
    this.failAll(new Error('Pi session detached'))
    this.queue.close()
  }
  async close() {
    if (this.closed) return
    this.closed = true
    if (this.child) {
      try {
        if (this.running) this.write({ type: 'abort' })
        this.child.stdin.end()
      } catch {
        /* closing */
      }
      const child = this.child
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill()
      }, 1500)
      timer.unref?.()
    }
    this.failAll(new Error('Pi session closed'))
    this.queue.close()
  }
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0)
function piContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  const text = content
    .flatMap((part) =>
      isObj(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('\n')
    .trim()
  return text || undefined
}
