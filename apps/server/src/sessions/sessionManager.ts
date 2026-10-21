import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import type { ProviderInstance, RpcParams, SessionEvent } from '@beddcode/contracts'
import type { ProviderAdapter, ProviderSession } from '@beddcode/provider-core'
import type { Logger } from '@beddcode/shared'
import type { AttachmentStore } from '../attachments/store.ts'
import type { EventStore } from '../store/eventStore.ts'
import type { GitService } from '../workspace/git.ts'

export interface SessionManagerDeps {
  store: EventStore
  attachments: AttachmentStore
  git: GitService
  adapters: ProviderAdapter[]
  log: Logger
  /** Used when a client does not pick a folder. */
  defaultCwd: string
  /** How long detection results are reused when starting sessions. */
  detectTtlMs?: number
}

interface LiveSession {
  session: ProviderSession
  adapter: ProviderAdapter
}

export class SessionManager {
  private readonly live = new Map<string, LiveSession>()
  private readonly resuming = new Map<string, Promise<LiveSession>>()
  private detected: {
    at: number
    instances: { adapter: ProviderAdapter; instance: ProviderInstance }[]
  } | null = null

  constructor(private readonly deps: SessionManagerDeps) {}

  /** Forget cached detection, e.g. after an ACP agent was added or removed. */
  invalidateDetection() {
    this.detected = null
  }

  async listProviders(): Promise<ProviderInstance[]> {
    return (await this.detect(true)).map((d) => d.instance)
  }

  async create(params: RpcParams<'sessions.create'>): Promise<{ sessionId: string }> {
    const { adapter, instance } = await this.findInstance(params.instanceId)
    const sessionId = randomUUID()
    const folder = params.cwd ?? this.deps.defaultCwd
    if (!isDirectory(folder)) throw new Error(`Folder does not exist: ${folder}`)

    // Where the agent actually works: the folder itself, or a fresh worktree of its repository.
    const info = await this.deps.git.info(folder).catch(() => null)
    let cwd = folder
    let branch = info?.isRepo ? info.branch : undefined
    let worktree: { baseBranch: string } | undefined
    if (params.workspace?.mode === 'worktree') {
      if (!info?.isRepo) throw new Error('Worktrees need a git repository')
      const made = await this.deps.git.createWorktree(folder, {
        branch: params.workspace.branch,
        baseBranch: params.workspace.baseBranch,
      })
      cwd = made.path
      branch = made.branch
      worktree = { baseBranch: made.baseBranch }
    }

    let session: ProviderSession
    try {
      session = await adapter.startSession(instance.id, {
        sessionId,
        cwd,
        additionalDirectories: [this.deps.attachments.root],
        permissionMode: params.permissionMode,
        model: params.model,
        effort: params.effort,
      })
    } catch (err) {
      // Do not leave an unused worktree behind when the agent could not start.
      if (worktree) await this.deps.git.removeWorktree(cwd).catch(() => false)
      throw err
    }
    this.live.set(sessionId, { session, adapter })

    const projectPath = info?.isRepo ? (info.mainRoot ?? info.root ?? folder) : folder
    this.deps.store.append({
      type: 'session.created',
      sessionId,
      at: Date.now(),
      title: params.title ?? defaultTitle(projectPath),
      cwd,
      projectPath,
      branch,
      worktree,
      instanceId: instance.id,
      permissionMode: params.permissionMode,
      model: params.model,
      effort: params.effort,
    })
    this.announceModes(sessionId, adapter, instance.id, params.permissionMode)
    void this.pump(sessionId, session)
    return { sessionId }
  }

  async prompt(sessionId: string, text: string, attachmentIds: string[] = []): Promise<void> {
    const attachments = attachmentIds.map((id) => {
      const found = this.deps.attachments.get(id)
      if (!found) throw new Error('An attachment is no longer available; attach it again')
      return { name: found.name, path: found.path }
    })
    if (!text.trim() && attachments.length === 0) throw new Error('Nothing to send')

    // A session whose process ended (server restart, crash) is resumed transparently.
    const { session } = await this.ensureLive(sessionId)
    this.deps.store.append({
      type: 'message.delta',
      sessionId,
      at: Date.now(),
      role: 'user',
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
    // Agents read attachments from disk, so the prompt names each file's absolute path.
    const providerText =
      attachments.length === 0
        ? text
        : `${text}\n\nAttached files:\n${attachments.map((a) => `- ${a.path}`).join('\n')}`.trim()
    // The provider call resolves when the turn ends; the caller only needs acceptance.
    session.prompt({ text: providerText }).catch((err: unknown) => {
      this.deps.log.error(`prompt failed for ${sessionId}`, err)
      this.deps.store.append({
        type: 'error',
        sessionId,
        at: Date.now(),
        message: err instanceof Error ? err.message : String(err),
      })
    })
  }

  interrupt(sessionId: string): Promise<void> {
    return this.requireLive(sessionId).session.interrupt()
  }

  rename(sessionId: string, title: string): void {
    if (!this.createdEvent(sessionId)) throw new Error(`Unknown session: ${sessionId}`)
    this.deps.store.append({ type: 'session.renamed', sessionId, at: Date.now(), title })
  }

  /** Deletes the worktree a session was started in. The session's branch and history are kept. */
  async removeWorktree(sessionId: string): Promise<boolean> {
    const created = this.createdEvent(sessionId)
    if (!created?.worktree) return false
    // The agent must stop using the folder before it is deleted.
    const live = this.live.get(sessionId)
    if (live) {
      await live.session.close()
      this.live.delete(sessionId)
    }
    return this.deps.git.removeWorktree(created.cwd)
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const { session, adapter } = this.requireLive(sessionId)
    await session.setPermissionMode(modeId)
    const created = this.createdEvent(sessionId)
    if (created) this.announceModes(sessionId, adapter, created.instanceId, modeId)
  }

  approve(sessionId: string, requestId: string, optionId: string): Promise<void> {
    return this.requireLive(sessionId).session.respondToApproval(requestId, optionId)
  }

  async close() {
    await Promise.all([...this.live.values()].map((l) => l.session.close()))
    this.live.clear()
  }

  private async detect(force = false) {
    const ttl = this.deps.detectTtlMs ?? 60_000
    if (!force && this.detected && Date.now() - this.detected.at < ttl)
      return this.detected.instances
    const perAdapter = await Promise.all(
      this.deps.adapters.map(async (adapter) =>
        (await adapter.detect()).map((instance) => ({ adapter, instance })),
      ),
    )
    this.detected = { at: Date.now(), instances: perAdapter.flat() }
    return this.detected.instances
  }

  private async findInstance(instanceId: string) {
    const found = (await this.detect()).find((d) => d.instance.id === instanceId)
    if (!found) throw new Error(`Unknown provider instance: ${instanceId}`)
    if (found.instance.status !== 'ready') {
      throw new Error(`${found.instance.label} is not ready (${found.instance.status})`)
    }
    return found
  }

  private requireLive(sessionId: string): LiveSession {
    const live = this.live.get(sessionId)
    if (!live) throw new Error(`Session is not running: ${sessionId}`)
    return live
  }

  private ensureLive(sessionId: string): Promise<LiveSession> {
    const live = this.live.get(sessionId)
    if (live) return Promise.resolve(live)
    // Two prompts arriving together must not start two provider processes.
    let pending = this.resuming.get(sessionId)
    if (!pending) {
      pending = this.resume(sessionId).finally(() => this.resuming.delete(sessionId))
      this.resuming.set(sessionId, pending)
    }
    return pending
  }

  private async resume(sessionId: string): Promise<LiveSession> {
    const events = this.deps.store.readSession(sessionId)
    const created = events.find(
      (e): e is { seq: number; event: Extract<SessionEvent, { type: 'session.created' }> } =>
        e.event.type === 'session.created',
    )
    if (!created) throw new Error(`Unknown session: ${sessionId}`)
    const providerSession = events
      .map((e) => e.event)
      .findLast((e) => e.type === 'session.provider-session')
    const resumeId =
      providerSession?.type === 'session.provider-session'
        ? providerSession.providerSessionId
        : undefined

    const { adapter, instance } = await this.findInstance(created.event.instanceId)
    if (!adapter.capabilities(instance.id).resume || !resumeId) {
      throw new Error(`${instance.label} cannot resume this session`)
    }

    // Continue in the mode the user last chose, not the one the session started with.
    const lastModes = events.map((e) => e.event).findLast((e) => e.type === 'session.modes')
    const mode =
      lastModes?.type === 'session.modes' && lastModes.currentModeId
        ? lastModes.currentModeId
        : created.event.permissionMode

    const session = await adapter.startSession(instance.id, {
      sessionId,
      cwd: created.event.cwd,
      additionalDirectories: [this.deps.attachments.root],
      permissionMode: mode,
      model: created.event.model,
      effort: created.event.effort,
      resumeId,
    })
    const live = { session, adapter }
    this.live.set(sessionId, live)
    void this.pump(sessionId, session)
    return live
  }

  /**
   * Providers with a fixed mode list (Claude, Codex) have the host record the current mode, so the
   * UI reads it from the log like everything else. ACP agents report their own modes instead.
   */
  private announceModes(
    sessionId: string,
    adapter: ProviderAdapter,
    instanceId: string,
    modeId: string | undefined,
  ) {
    const modes = adapter.capabilities(instanceId).permissionModes
    if (modes.length === 0) return
    this.deps.store.append({
      type: 'session.modes',
      sessionId,
      at: Date.now(),
      modes: modes.map(({ id, label, description, dangerous }) => ({
        id,
        label,
        description,
        dangerous,
      })),
      currentModeId: modeId ?? modes[0]?.id,
    })
  }

  private createdEvent(sessionId: string) {
    for (const { event } of this.deps.store.readSession(sessionId)) {
      if (event.type === 'session.created') return event
    }
    return undefined
  }

  /** Copies the provider's normalized events into the durable log. */
  private async pump(sessionId: string, session: ProviderSession) {
    try {
      for await (const event of session.events) this.deps.store.append(event)
    } catch (err) {
      this.deps.log.error(`event stream failed for ${sessionId}`, err)
    } finally {
      if (this.live.get(sessionId)?.session === session) this.live.delete(sessionId)
    }
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function defaultTitle(cwd: string): string {
  return `Session in ${path.basename(cwd) || cwd}`
}
