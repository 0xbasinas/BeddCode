import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionModeOption, QuestionSpec, SessionEvent } from '@beddcode/contracts'
import type { PromptInput, ProviderSession, StartSessionInput } from '@beddcode/provider-core'
import { createAsyncQueue, deferred, type Deferred, type Logger } from '@beddcode/shared'
import { ClaudeEventMapper, toolKind, toolTitle } from '../mapper.ts'
import { ApprovalBridge, SOCKET_ENV, type ApprovalRequest } from './approvalBridge.ts'
import { ClaudeCliProcess } from './process.ts'
import { approvalBridgeProgram } from './approvalBridgeProgram.ts'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never
export interface ClaudeCliSessionDeps { executablePath?: string; env?: Record<string, string | undefined>; log: Logger; modes?: PermissionModeOption[] }

export class ClaudeCliSession implements ProviderSession {
  readonly sessionId: string
  private readonly queue = createAsyncQueue<SessionEvent>()
  private readonly mapper: ClaudeEventMapper
  private readonly bridge?: ApprovalBridge
  private readonly ready: Promise<void>
  private process?: ClaudeCliProcess
  private closed = false
  private active = false
  private turns = 0
  private requests = 0
  private waiters: Deferred<void>[] = []
  private pending = new Map<string, { bridgeId: string; request: ApprovalRequest; questions?: Map<string, string> }>()
  constructor(private readonly input: StartSessionInput, private readonly deps: ClaudeCliSessionDeps) {
    this.sessionId = input.sessionId
    this.mapper = new ClaudeEventMapper(input.sessionId, { cwd: input.cwd, resumed: !!input.resumeId })
    if (input.permissionMode !== 'bypassPermissions') this.bridge = new ApprovalBridge(join(tmpdir(), `beddcode-${randomUUID()}.sock`))
    this.bridge?.on('request', (id: string, request: ApprovalRequest) => this.approval(id, request))
    this.ready = this.start()
    void this.ready.catch(() => {})
  }
  private async start() {
    await this.bridge?.start()
    if (this.closed) { await this.bridge?.stop(); return }
    const servers: Record<string, unknown> = Object.fromEntries((this.input.mcpServers ?? []).map((m) => [m.name, { command: m.command, args: m.args, env: m.env }]))
    // The host is bundled into a single desktop file, so embed the bundled helper for both dev and production.
    if (this.bridge) servers.beddcode = { command: process.execPath, args: ['-e', approvalBridgeProgram], env: { [SOCKET_ENV]: this.bridge.path } }
    this.process = new ClaudeCliProcess({ cwd: this.input.cwd, executablePath: this.deps.executablePath, env: this.deps.env, model: this.input.model, effort: this.input.effort, resumeId: this.input.resumeId, sessionId: this.input.resumeId ? undefined : randomUUID(), permissionMode: this.input.permissionMode ?? 'default', additionalDirectories: this.input.additionalDirectories, mcpConfig: Object.keys(servers).length ? JSON.stringify({ mcpServers: servers }) : undefined, permissionPromptTool: this.bridge ? 'mcp__beddcode__approve' : undefined })
    void this.pump()
  }
  get events() { return this.queue }
  private emit(event: Draft, turnId?: string) { this.queue.push({ ...event, sessionId: this.sessionId, turnId, at: Date.now() } as SessionEvent) }
  private turn() { return `turn-${this.turns}` }
  async prompt(input: PromptInput) {
    if (this.closed) throw new Error('session is closed')
    await this.ready
    if (this.closed || !this.process) throw new Error('session is closed')
    const turn = `turn-${++this.turns}`
    this.mapper.setTurn(turn); this.active = true
    const done = deferred<void>(); this.waiters.push(done)
    this.emit({ type: 'turn.started' }, turn)
    try { await this.process.send(input.text, input.attachments) } catch (err) { this.waiters.splice(this.waiters.indexOf(done), 1); this.active = false; throw err }
    await done.promise
  }
  async steer(input: PromptInput) { if (!this.active) return this.prompt(input); await this.ready; await this.process!.send(input.text, input.attachments, 'next') }
  async interrupt() { this.mapper.markInterrupted(); this.denyPending('Interrupted'); await this.ready; try { await this.process?.control({ subtype: 'interrupt' }) } catch { this.process?.interrupt() } }
  async setModel(model: string | undefined, _effort: string | undefined) { await this.ready; await this.process?.control({ subtype: 'set_model', model: model ?? null }) }
  async setPermissionMode(mode: string) { await this.ready; await this.process?.control({ subtype: 'set_permission_mode', mode }) }
  private approval(bridgeId: string, request: ApprovalRequest) {
    if ((this.input.mcpServers ?? []).some((m) => (m.autoAllow ?? []).some((t) => request.tool_name === `mcp__${m.name}__${t}`))) { this.bridge!.resolve(bridgeId, { behavior: 'allow', updatedInput: request.input }); return }
    const id = `req-${++this.requests}`
    if (request.tool_name === 'AskUserQuestion') {
      const texts = new Map<string, string>()
      const questions: QuestionSpec[] = (Array.isArray(request.input.questions) ? request.input.questions as Record<string, unknown>[] : []).map((q, i) => {
        const qid = `q${i}`, question = typeof q.question === 'string' ? q.question : `Question ${i + 1}`; texts.set(qid, question)
        return { id: qid, question, header: typeof q.header === 'string' ? q.header : undefined, options: Array.isArray(q.options) ? (q.options as Record<string, unknown>[]).map((o) => ({ label: String(o.label ?? ''), description: typeof o.description === 'string' ? o.description : undefined })) : undefined, multiSelect: q.multiSelect === true, allowOther: true }
      })
      this.pending.set(id, { bridgeId, request, questions: texts }); this.emit({ type: 'question.requested', requestId: id, questions }, this.turn()); return
    }
    this.pending.set(id, { bridgeId, request })
    const plan = request.tool_name === 'ExitPlanMode' && typeof request.input.plan === 'string' ? request.input.plan : undefined
    const detail = typeof request.input.command === 'string' ? request.input.command : typeof request.input.file_path === 'string' ? request.input.file_path : undefined
    this.emit({ type: 'approval.requested', requestId: id, title: plan !== undefined ? 'Ready to start with this plan?' : `${toolTitle(request.tool_name, request.input, this.input.cwd)}?`, detail: plan !== undefined ? undefined : detail || (toolKind(request.tool_name) === 'other' ? undefined : undefined), plan, options: plan !== undefined ? [{ id: 'allow', label: 'Approve plan', kind: 'allow' }, { id: 'allow-edits', label: 'Approve and auto-accept edits', kind: 'allow' }, { id: 'deny', label: 'Keep planning', kind: 'deny' }] : [{ id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }] }, this.turn())
  }
  async respondToApproval(id: string, option: string) { const p = this.pending.get(id); if (!p || p.questions) throw new Error(`No pending approval ${id}`); this.pending.delete(id); if (option === 'allow-edits') await this.setPermissionMode('acceptEdits'); this.bridge!.resolve(p.bridgeId, option === 'deny' ? { behavior: 'deny', message: 'The user denied this action.' } : { behavior: 'allow', updatedInput: p.request.input }); this.emit({ type: 'approval.resolved', requestId: id, optionId: option }, this.turn()) }
  async answerQuestion(id: string, answers?: Record<string, string[]>) { const p = this.pending.get(id); if (!p?.questions) throw new Error(`No pending question ${id}`); this.pending.delete(id); const mapped: Record<string, string> = {}; for (const [key, value] of Object.entries(answers ?? {})) mapped[p.questions.get(key) ?? key] = value.join(', '); this.bridge!.resolve(p.bridgeId, answers ? { behavior: 'allow', updatedInput: { ...p.request.input, answers: mapped } } : { behavior: 'deny', message: 'The user dismissed the question.' }); this.emit({ type: 'question.resolved', requestId: id, answers }, this.turn()) }
  private denyPending(message: string) { for (const [id, p] of this.pending) { this.bridge?.resolve(p.bridgeId, { behavior: 'deny', message }); if (p.questions) this.emit({ type: 'question.resolved', requestId: id }, this.turn()); else this.emit({ type: 'approval.resolved', requestId: id, optionId: 'deny' }, this.turn()) } this.pending.clear() }
  async close() { if (this.closed) return; this.closed = true; this.denyPending('Session closed'); await this.ready.catch(() => {}); this.process?.close(); await this.bridge?.stop(); for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('session closed')); this.queue.close() }
  private async pump() { try { for await (const msg of this.process!.messages()) for (const event of this.mapper.map(msg)) { this.queue.push(event); if (event.type === 'turn.completed') { this.active = false; this.waiters.shift()?.resolve() } } } catch (err) { if (!this.closed) { this.deps.log.error(`claude stream failed for ${this.sessionId}`, err); this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) }, this.turn()); this.emit({ type: 'turn.completed', reason: 'error' }, this.turn()); for (const waiter of this.waiters.splice(0)) waiter.resolve() } } finally { for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Claude process ended')); if (!this.closed) { this.closed = true; this.denyPending('Process ended'); await this.bridge?.stop(); this.queue.close() } } }
}
