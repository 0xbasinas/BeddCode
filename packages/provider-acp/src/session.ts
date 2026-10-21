import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  InitializeResponse,
  PermissionOption,
  RequestPermissionRequest,
  SessionUpdate,
} from '@agentclientprotocol/sdk'
import type { SessionEvent } from '@beddcode/contracts'
import type { ProviderSession, PromptInput, StartSessionInput } from '@beddcode/provider-core'
import {
  JsonRpcClient,
  JsonRpcError,
  createAsyncQueue,
  type Logger,
  type Transport,
} from '@beddcode/shared'
import { AcpEventMapper } from './mapper.ts'
import { TerminalManager } from './terminals.ts'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never
type Obj = Record<string, unknown>

const PROTOCOL_VERSION = 1

export interface AcpSessionDeps {
  transport: Transport
  log: Logger
  label: string
  clientVersion?: string
}

interface Modes {
  currentModeId?: string
  availableModes?: { id: string; name: string; description?: string | null }[]
}

export class AcpSession implements ProviderSession {
  readonly sessionId: string
  private readonly queue = createAsyncQueue<SessionEvent>()
  private readonly rpc: JsonRpcClient
  private readonly mapper: AcpEventMapper
  private modes: { id: string; label: string; description?: string }[] = []
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

  constructor(
    private readonly input: StartSessionInput,
    private readonly deps: AcpSessionDeps,
  ) {
    this.sessionId = input.sessionId
    this.mapper = new AcpEventMapper(input.sessionId)
    this.terminals = new TerminalManager(input.cwd)
    this.rpc = new JsonRpcClient(deps.transport, deps.log, { jsonrpc2: true })
    this.rpc.onNotification((method, params) => this.onNotification(method, params))
    this.rpc.onRequest((method, params) => this.onClientRequest(method, params))
    this.rpc.onClose(() => this.fail(`${deps.label} stopped unexpectedly`))
    this.ready = this.init()
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
      const init = await this.rpc.request<InitializeResponse>('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: {
          name: 'beddcode',
          title: 'BeddCode',
          version: this.deps.clientVersion ?? '0.0.0',
        },
      })
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `${this.deps.label} speaks ACP v${init.protocolVersion}, which is not supported yet`,
        )
      }

      const caps = init.agentCapabilities
      const extra = this.input.additionalDirectories ?? []
      const base = {
        cwd: this.input.cwd,
        mcpServers: [] as unknown[],
        // Only sent when the agent says it understands it.
        ...(extra.length > 0 && caps?.sessionCapabilities?.additionalDirectories
          ? { additionalDirectories: extra }
          : {}),
      }
      let modes: Modes | undefined

      if (this.input.resumeId) {
        this.acpSessionId = this.input.resumeId
        if (caps?.sessionCapabilities?.resume) {
          const res = await this.rpc.request<{ modes?: Modes }>('session/resume', {
            sessionId: this.acpSessionId,
            ...base,
          })
          modes = res.modes
        } else if (caps?.loadSession) {
          this.replaying = true
          try {
            const res = await this.rpc.request<{ modes?: Modes }>('session/load', {
              sessionId: this.acpSessionId,
              ...base,
            })
            modes = res.modes
          } finally {
            this.replaying = false
          }
        } else {
          throw new Error(`${this.deps.label} cannot resume sessions`)
        }
      } else {
        const res = await this.rpc.request<{ sessionId: string; modes?: Modes }>(
          'session/new',
          base,
        )
        this.acpSessionId = res.sessionId
        modes = res.modes
      }

      this.emit({ type: 'session.provider-session', providerSessionId: this.acpSessionId })
      await this.announceModes(modes)
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /** Reports the agent's own modes and applies the one the user asked for, if the agent has it. */
  private async announceModes(modes: Modes | undefined) {
    const list = (modes?.availableModes ?? []).map((m) => ({
      id: m.id,
      label: m.name,
      description: m.description ?? undefined,
    }))
    if (list.length === 0) return
    this.modes = list
    this.mapper.setModes(list)
    let current = modes?.currentModeId
    const wanted = this.input.permissionMode
    if (wanted && wanted !== current && list.some((m) => m.id === wanted)) {
      await this.rpc.request('session/set_mode', { sessionId: this.acpSessionId, modeId: wanted })
      current = wanted
    }
    this.emit({ type: 'session.modes', modes: list, currentModeId: current })
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

    try {
      const res = await this.rpc.request<{ stopReason: string }>('session/prompt', {
        sessionId: this.acpSessionId,
        prompt: [{ type: 'text', text: input.text }],
      })
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
    }
  }

  async interrupt() {
    this.cancelAllPending()
    if (this.acpSessionId) this.rpc.notify('session/cancel', { sessionId: this.acpSessionId })
  }

  async setPermissionMode(modeId: string) {
    await this.ready
    await this.rpc.request('session/set_mode', { sessionId: this.acpSessionId, modeId })
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
    this.rpc.close()
    this.queue.close()
  }

  private currentTurn() {
    return `turn-${this.turnCount}`
  }

  private onNotification(method: string, params: unknown) {
    if (method !== 'session/update' || this.replaying) return
    const p = params as { sessionId?: string; update?: SessionUpdate }
    if (p.sessionId !== this.acpSessionId || !p.update) return
    for (const event of this.mapper.map(p.update)) this.queue.push(event)
  }

  private async onClientRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Obj
    switch (method) {
      case 'session/request_permission':
        return this.askPermission(p as unknown as RequestPermissionRequest)

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
        throw new JsonRpcError(-32601, `Method not found: ${method}`)
    }
  }

  private absolute(value: unknown): string {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new JsonRpcError(-32602, 'path must be absolute')
    }
    return value
  }

  /** Shows the agent's own options and returns the one the user picks, by its own id. */
  private askPermission(req: RequestPermissionRequest): Promise<unknown> {
    const requestId = `req-${++this.approvalCount}`
    const tool = req.toolCall
    const raw = (tool.rawInput ?? {}) as Obj
    const detail =
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
    for (const [requestId, answer] of this.pending) {
      answer(null)
      this.emit({ type: 'approval.resolved', requestId, optionId: 'cancelled' }, this.currentTurn())
    }
    this.pending.clear()
  }

  private fail(message: string) {
    if (this.closed) return
    this.closed = true
    this.terminals.releaseAll()
    this.emit({ type: 'error', message }, this.currentTurn())
    if (this.inflightTurn) {
      this.emit({ type: 'turn.completed', reason: 'error' }, this.inflightTurn)
      this.inflightTurn = null
    }
    this.queue.close()
  }
}
