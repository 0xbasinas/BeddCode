import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises'
import os from 'node:os'
import { gitTextPrompt, parseGitText } from '../workspace/gitText.ts'
import type {
  AgentPreview,
  GitDiff,
  HistoryEntry,
  McpServer,
  McpServerInput,
  ProviderInstance,
  RpcParams,
  RpcResult,
  SessionEvent,
  SlashCommand,
  UsageLimits,
  UsageSummary,
} from '@beddcode/contracts'
import type {
  HistoryTurn,
  ProviderAdapter,
  ProviderSession,
  SessionMcpServer,
} from '@beddcode/provider-core'
import type { Logger } from '@beddcode/shared'
import { PreviewSeeds, type PreviewCache } from '../agents/previews.ts'
import type { AttachmentStore } from '../attachments/store.ts'
import type { EventStore } from '../store/eventStore.ts'
import { summarizeUsage } from '../usage/summary.ts'
import type { GitService } from '../workspace/git.ts'

export interface SessionManagerDeps {
  store: EventStore
  attachments: AttachmentStore
  git: GitService
  adapters: ProviderAdapter[]
  log: Logger
  /** Used when a client does not pick a folder. */
  defaultCwd: string
  /** Persistent working folders for sessions without a project. */
  sessionRoot?: string
  /** How long detection results are reused when starting sessions. */
  detectTtlMs?: number
  /** Remembers what agents offer for new sessions (see `previewAgent`). */
  previews?: PreviewCache
  /** MCP servers to add to a session that may use BeddCode's agent tools. */
  agentToolServers?: (sessionId: string) => SessionMcpServer[]
}

/** Where a session came from, when not straight from the user. */
export interface SessionOrigin {
  parent?: { sessionId: string; depth: number }
  schedule?: { id: string; name: string }
}

interface LiveSession {
  session: ProviderSession
  adapter: ProviderAdapter
}

interface QueuedPrompt {
  queueId: string
  text: string
  attachments: { name: string; path: string }[]
}

/** What the host tracks about a session's current turn and its waiting messages. */
interface TurnState {
  /** A turn is running (or about to). */
  busy: boolean
  queue: QueuedPrompt[]
  /** Send this queued message as soon as the interrupted turn ends. */
  sendAfterInterrupt?: string
  /** The snapshot taken as the running turn started (see `turn.changes`). */
  before?: { hash: string; refBase: string }
  /** The message is answered but not yet with the agent: the snapshot comes first. */
  starting?: Promise<void>
  /** The starting snapshot, still being taken after the message was already sent. */
  taking?: Promise<void>
  /** Recording the last turn's changes; the next turn waits so the snapshots do not overlap. */
  settling?: Promise<void>
}

/**
 * How long the agent's start waits for the turn's starting snapshot before going ahead without
 * one (the snapshot then carries on). The sender is answered at once either way. Waiting for the
 * snapshot matters: an agent that starts first can edit files the snapshot would then include,
 * and the turn's changes and undo would miss them.
 */
const CHECKPOINT_GRACE_MS = 4_000
/** Folders with more untracked (and not ignored) files than this get no turn snapshots. */
const CHECKPOINT_MAX_UNTRACKED = 5_000
/** Turns per session whose snapshots are kept (for their diffs); older ones are dropped. */
const CHECKPOINTS_KEPT = 20

/** A remembered agent preview older than this is probed again before it is shown. */
const PREVIEW_REFRESH_MS = 60 * 60_000
/** How long the new-session screen waits for that fresh probe before showing the old answer. */
const PREVIEW_REFRESH_WAIT_MS = 4_000

export class SessionManager {
  private readonly live = new Map<string, LiveSession>()
  private readonly resuming = new Map<string, Promise<LiveSession>>()
  private readonly turns = new Map<string, TurnState>()
  private detected: {
    at: number
    instances: { adapter: ProviderAdapter; instance: ProviderInstance }[]
  } | null = null
  private readonly gitGenerations = new Set<string>()

  constructor(private readonly deps: SessionManagerDeps) {}

  async generateGitText(params: RpcParams<'git.generate'>): Promise<RpcResult<'git.generate'>> {
    const key = JSON.stringify([params.sessionId ?? params.cwd, params.kind])
    if (this.gitGenerations.has(key))
      throw new Error('A draft is already being generated for this workspace')
    this.gitGenerations.add(key)
    try {
      return await this.generateGitTextOnce(params)
    } finally {
      this.gitGenerations.delete(key)
    }
  }

  private async generateGitTextOnce(
    params: RpcParams<'git.generate'>,
  ): Promise<RpcResult<'git.generate'>> {
    const event = params.sessionId
      ? this.deps.store
          .readSession(params.sessionId)
          .find((e) => e.event.type === 'session.created')?.event
      : undefined
    const created = event?.type === 'session.created' ? event : undefined
    if (params.sessionId && !created) throw new Error('Session not found')
    const folder = created?.cwd ?? params.cwd
    if (!folder) throw new Error('Choose a working folder')
    // The selected instance was already detected for the picker. Starting it verifies current
    // credentials; do not rediscover every other provider just to generate a short draft.
    const available = (d: { instance: ProviderInstance }) =>
      d.instance.id === params.instanceId && d.instance.status === 'ready'
    const found = this.detected?.instances.find(available) ?? (await this.detect()).find(available)
    if (!found?.adapter.generateText)
      throw new Error('Choose an available agent that supports text generation')
    const context = await this.deps.git.generationContext(
      folder,
      params.kind,
      params.paths,
      params.base,
    )
    // Supplying the diff avoids loading project instructions, hooks or MCP configuration.
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'beddcode-git-text-'))
    try {
      const model =
        created && params.sessionId && found.instance.id === created.instanceId
          ? this.deps.store.sessionMeta([params.sessionId]).get(params.sessionId)?.model
          : undefined
      const efforts =
        found.instance.capabilities.models?.find((m) => m.id === model)?.efforts ??
        found.instance.capabilities.efforts ??
        []
      const effort = ['minimal', 'low'].find((e) => efforts.includes(e))
      const text = await found.adapter.generateText({
        instanceId: found.instance.id,
        cwd,
        prompt: gitTextPrompt(params.kind, context),
        model,
        effort,
      })
      const current = await this.deps.git.generationContext(
        folder,
        params.kind,
        params.paths,
        params.base,
      )
      if (current.text !== context.text)
        throw new Error(
          'The changes moved while generating. Review the files and generate a new draft.',
        )
      return { ...parseGitText(params.kind, text), truncated: context.truncated }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }

  /** What the agents used over the last `days` days, from the usage they reported. */
  async usageSummary(days: number): Promise<UsageSummary> {
    const labels = new Map((await this.detect()).map((d) => [d.instance.id, d.instance.label]))
    return summarizeUsage(this.deps.store, days, Date.now(), (id) => labels.get(id) ?? id)
  }

  /** The plan limits each agent reports. Agents that cannot say, or fail to, come with a note. */
  async usageLimits(): Promise<UsageLimits[]> {
    const found = await this.detect()
    const rows = await Promise.all(
      found
        .filter((d) => d.instance.status === 'ready' && d.instance.kind !== 'fake')
        .map(async ({ adapter, instance }): Promise<UsageLimits> => {
          // Agents with no plan to report (most ACP agents) still show up, with a note.
          if (!adapter.limits) {
            return {
              instanceId: instance.id,
              label: instance.label,
              windows: [],
              note: `${instance.label} does not report plan limits to other apps. What it reports for each turn (tokens, and cost when it says) is counted below; its own app shows the account allowance.`,
            }
          }
          try {
            const limits = await adapter.limits(instance.id)
            return { instanceId: instance.id, label: instance.label, ...limits }
          } catch (err) {
            return {
              instanceId: instance.id,
              label: instance.label,
              windows: [],
              note: err instanceof Error ? err.message : String(err),
            }
          }
        }),
    )
    return rows
  }

  /** Forget cached detection, e.g. after an ACP agent was added or removed. */
  invalidateDetection() {
    this.detected = null
    // An agent was added, removed or changed: what it offers may have changed too.
    this.deps.previews?.clearAll()
  }

  async listProviders(): Promise<ProviderInstance[]> {
    return (await this.detect(true)).map((d) => d.instance)
  }

  async create(
    params: RpcParams<'sessions.create'>,
    origin: SessionOrigin = {},
  ): Promise<{ sessionId: string }> {
    if (params.projectless && (params.cwd !== undefined || params.workspace?.mode === 'worktree'))
      throw new Error('A session without a project cannot use a project folder or a worktree')
    const { adapter, instance } = await this.findInstance(params.instanceId)
    const sessionId = randomUUID()
    const folder = params.projectless
      ? await this.scratchFolder(sessionId)
      : (params.cwd ?? this.deps.defaultCwd)
    if (!isDirectory(folder)) throw new Error(`Folder does not exist: ${folder}`)

    // Where the agent actually works: the folder itself, or a fresh worktree of its repository.
    const info = params.projectless ? null : await this.deps.git.info(folder).catch(() => null)
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
        config: params.config,
        mcpServers: this.toolServersFor(
          sessionId,
          params.agentTools || params.browserTools || params.designTools,
        ),
      })
    } catch (err) {
      // Do not leave an unused worktree behind when the agent could not start.
      if (worktree) await this.deps.git.removeWorktree(cwd).catch(() => false)
      // Remove only an empty folder; preserve any files the agent wrote before failing.
      if (params.projectless) await rmdir(folder).catch(() => {})
      throw err
    }
    this.live.set(sessionId, { session, adapter })

    const projectPath = info?.isRepo ? (info.mainRoot ?? info.root ?? folder) : folder
    this.deps.store.append({
      type: 'session.created',
      sessionId,
      at: Date.now(),
      title: params.title ?? (params.projectless ? 'New session' : defaultTitle(projectPath)),
      cwd,
      projectPath,
      projectless: params.projectless || undefined,
      branch,
      worktree,
      instanceId: instance.id,
      permissionMode: params.permissionMode,
      model: params.model,
      effort: params.effort,
      parent: origin.parent,
      schedule: origin.schedule,
      agentTools: (params.agentTools && this.deps.agentToolServers !== undefined) || undefined,
      browserTools: (params.browserTools && this.deps.agentToolServers !== undefined) || undefined,
      designTools: (params.designTools && this.deps.agentToolServers !== undefined) || undefined,
    })
    this.announceModes(sessionId, adapter, instance.id, params.permissionMode)
    void this.pump(sessionId, session)
    return { sessionId }
  }

  private async scratchFolder(name: string): Promise<string> {
    const root = this.deps.sessionRoot ?? path.resolve(this.deps.attachments.root, '../sessions')
    const folder = path.join(root, name)
    await mkdir(folder, { recursive: true })
    return folder
  }

  async prompt(
    sessionId: string,
    text: string,
    attachmentIds: string[] = [],
    mode: 'auto' | 'queue' = 'auto',
  ): Promise<RpcResult<'sessions.prompt'>> {
    const attachments = attachmentIds.map((id) => {
      const found = this.deps.attachments.get(id)
      if (!found) throw new Error('An attachment is no longer available; attach it again')
      return { name: found.name, path: found.path }
    })
    if (!text.trim() && attachments.length === 0) throw new Error('Nothing to send')

    // A session whose process ended (server restart, crash) is resumed transparently.
    const live = await this.ensureLive(sessionId)
    const turn = this.turnState(sessionId)
    if (!turn.busy) {
      await this.startTurn(sessionId, live, text, attachments)
      return { state: 'started' }
    }

    // The agent is working. Steer the message into the running turn when it can take it there,
    // otherwise keep it for after the turn.
    if (mode === 'auto' && live.session.steer) {
      try {
        await live.session.steer(promptInput(text, attachments))
        this.appendUserMessage(sessionId, text, attachments)
        return { state: 'steered' }
      } catch (err) {
        // Some turns cannot take extra input (a compaction, a review); wait for the next one.
        this.deps.log.warn(`could not steer ${sessionId}; queueing instead`, err)
      }
    }
    const queueId = randomUUID()
    turn.queue.push({ queueId, text, attachments })
    this.deps.store.append({
      type: 'prompt.queued',
      sessionId,
      at: Date.now(),
      queueId,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
    return { state: 'queued', queueId }
  }

  /** Cancels a queued message, or pushes it ahead of the agent's current work. */
  async dequeue(sessionId: string, queueId: string, action: 'cancel' | 'steer'): Promise<void> {
    const turn = this.turnState(sessionId)
    const index = turn.queue.findIndex((q) => q.queueId === queueId)
    if (index < 0) throw new Error('That message is no longer waiting')
    const [item] = turn.queue.splice(index, 1)
    if (!item) return

    if (action === 'cancel') {
      this.deps.store.append({
        type: 'prompt.dequeued',
        sessionId,
        at: Date.now(),
        queueId,
        reason: 'cancelled',
      })
      return
    }

    const live = await this.ensureLive(sessionId)
    if (!turn.busy) {
      this.dequeued(sessionId, queueId, 'sent')
      await this.startTurn(sessionId, live, item.text, item.attachments)
    } else if (live.session.steer) {
      this.dequeued(sessionId, queueId, 'steered')
      this.appendUserMessage(sessionId, item.text, item.attachments)
      await live.session.steer(promptInput(item.text, item.attachments))
    } else {
      // No way to talk into the running turn: stop it and send this next.
      turn.queue.unshift(item)
      turn.sendAfterInterrupt = queueId
      await turn.starting
      await live.session.interrupt()
    }
  }

  /** Switches model and effort for the rest of the session; resuming later keeps the choice. */
  async setModel(sessionId: string, model: string | undefined, effort: string | undefined) {
    const { session, adapter } = await this.ensureLive(sessionId)
    const created = this.createdEvent(sessionId)
    if (!created) throw new Error(`Unknown session: ${sessionId}`)
    if (!session.setModel || !adapter.capabilities(created.instanceId).models?.length) {
      throw new Error('This agent does not let you change its model during a session')
    }
    await session.setModel(model, effort)
    this.deps.store.append({ type: 'session.model', sessionId, at: Date.now(), model, effort })
  }

  async setConfig(sessionId: string, optionId: string, value: string | boolean): Promise<void> {
    const { session } = this.requireLive(sessionId)
    if (!session.setConfigOption) throw new Error('This agent has no settings to change')
    await session.setConfigOption(optionId, value)
  }

  async answerQuestion(
    sessionId: string,
    requestId: string,
    answers?: Record<string, string[]>,
  ): Promise<void> {
    const { session } = this.requireLive(sessionId)
    if (!session.answerQuestion) throw new Error('This agent does not ask questions')
    await session.answerQuestion(requestId, answers)
  }

  private appendUserMessage(
    sessionId: string,
    text: string,
    attachments: { name: string; path: string }[],
  ) {
    this.deps.store.append({
      type: 'message.delta',
      sessionId,
      at: Date.now(),
      role: 'user',
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
  }

  private dequeued(sessionId: string, queueId: string, reason: 'sent' | 'steered') {
    this.deps.store.append({ type: 'prompt.dequeued', sessionId, at: Date.now(), queueId, reason })
  }

  /**
   * Begins a turn: records the user's message, snapshots the folder (so the turn's changes can be
   * shown and undone), and hands the prompt to the agent. Resolves once the agent has the prompt;
   * the provider call itself resolves when the turn ends.
   */
  private async startTurn(
    sessionId: string,
    { session }: LiveSession,
    text: string,
    attachments: { name: string; path: string }[],
  ): Promise<void> {
    const turn = this.turnState(sessionId)
    turn.busy = true
    this.appendUserMessage(sessionId, text, attachments)
    const failed = (err: unknown) => {
      turn.busy = false
      turn.before = undefined
      this.deps.log.error(`prompt failed for ${sessionId}`, err)
      this.deps.store.append({
        type: 'error',
        sessionId,
        at: Date.now(),
        message: err instanceof Error ? err.message : String(err),
      })
    }
    // The sender is answered now, with its message already in the log; waiting for the snapshot
    // of the folder would hold the composer for as long as git takes.
    const starting = (async () => {
      try {
        await turn.settling
        await turn.taking
        await this.checkpointBefore(sessionId, turn)
        session.prompt(promptInput(text, attachments)).catch(failed)
      } catch (err) {
        failed(err)
      }
    })()
    turn.starting = starting
    void starting.finally(() => {
      if (turn.starting === starting) turn.starting = undefined
    })
  }

  /** Where a session's turn snapshots go, or null when its folder is not a git repository. */
  private readonly checkpointRoots = new Map<string, Promise<string | null>>()
  private checkpointFolder(sessionId: string): Promise<string | null> {
    let found = this.checkpointRoots.get(sessionId)
    if (!found) {
      const created = this.createdEvent(sessionId)
      found =
        !created || created.projectless
          ? Promise.resolve(null)
          : this.deps.git
              .info(created.cwd)
              .then((info) => (info.isRepo ? created.cwd : null))
              .catch(() => null)
      this.checkpointRoots.set(sessionId, found)
    }
    return found
  }

  private async checkpointBefore(sessionId: string, turn: TurnState): Promise<void> {
    turn.before = undefined
    const cwd = await this.checkpointFolder(sessionId)
    if (!cwd) return
    const refBase = `refs/beddcode/checkpoints/${sessionId}/${Date.now().toString(36)}`
    const taking = this.deps.git
      .snapshot(cwd, `${refBase}-before`, { maxUntracked: CHECKPOINT_MAX_UNTRACKED })
      .then((hash) => ({ hash, refBase }))
      .catch((err: unknown) => {
        this.deps.log.debug(`no checkpoint for ${sessionId}: ${String(err)}`)
        return undefined
      })
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), CHECKPOINT_GRACE_MS)
    })
    const first = await Promise.race([taking, late])
    clearTimeout(timer)
    if (first !== 'late') {
      turn.before = first
      return
    }
    const finishing = taking.then((snapshot) => {
      turn.before = snapshot
    })
    turn.taking = finishing
    void finishing.finally(() => {
      if (turn.taking === finishing) turn.taking = undefined
    })
  }

  /** After a turn: snapshot again and record what changed, if anything. */
  private async recordTurnChanges(sessionId: string, turn: TurnState, turnId?: string) {
    await turn.taking
    const before = turn.before
    turn.before = undefined
    if (!before) return
    const cwd = await this.checkpointFolder(sessionId)
    if (!cwd) return
    try {
      const after = await this.deps.git.snapshot(cwd, `${before.refBase}-after`)
      const { files, truncated } = await this.deps.git.snapshotChanges(cwd, before.hash, after)
      if (files.length === 0) {
        await this.deps.git.dropSnapshots(cwd, `${before.refBase}-`)
        return
      }
      this.deps.store.append({
        type: 'turn.changes',
        sessionId,
        turnId,
        at: Date.now(),
        before: before.hash,
        after,
        files,
        truncated: truncated || undefined,
      })
      // Only the latest turn can be undone; older ones keep their diffs for a while, then go.
      await this.deps.git
        .pruneSnapshots(cwd, `refs/beddcode/checkpoints/${sessionId}/`, CHECKPOINTS_KEPT)
        .catch((err: unknown) => this.deps.log.debug(`could not prune checkpoints: ${String(err)}`))
    } catch (err) {
      this.deps.log.warn(`could not record the changes of a turn in ${sessionId}`, err)
    }
  }

  private turnChanges(sessionId: string, after: string) {
    let found: Extract<SessionEvent, { type: 'turn.changes' }> | undefined
    let latest: Extract<SessionEvent, { type: 'turn.changes' }> | undefined
    let reverted = false
    for (const { event } of this.deps.store.readSession(sessionId)) {
      if (event.type === 'turn.changes') {
        latest = event
        if (event.after === after) found = event
      } else if (event.type === 'turn.reverted' && event.after === after) {
        reverted = true
      }
    }
    if (!found) throw new Error('Those changes are not part of this session')
    return { changes: found, isLatest: latest === found, reverted }
  }

  /** One file's diff from a turn's changes. */
  async turnDiff(sessionId: string, after: string, file: string): Promise<GitDiff> {
    const { changes } = this.turnChanges(sessionId, after)
    if (!changes.files.some((f) => f.path === file || f.oldPath === file)) {
      throw new Error('That file did not change in this turn')
    }
    const created = this.createdEvent(sessionId)
    if (!created) throw new Error(`Unknown session: ${sessionId}`)
    return this.deps.git
      .snapshotDiff(created.cwd, changes.before, changes.after, file)
      .catch((err: unknown) => {
        if (/bad object|unknown revision|invalid object|not a valid object/i.test(String(err)))
          throw new Error(
            `This turn is too old: only the last ${CHECKPOINTS_KEPT} turns with changes keep their diffs`,
          )
        throw err
      })
  }

  /** Puts the files the latest turn changed back; see `sessions.undoTurn`. */
  async undoTurn(sessionId: string, after: string): Promise<{ restored: number }> {
    const created = this.createdEvent(sessionId)
    if (!created) throw new Error(`Unknown session: ${sessionId}`)
    const { changes, isLatest, reverted } = this.turnChanges(sessionId, after)
    if (reverted) throw new Error('Those changes were already undone')
    if (!isLatest) throw new Error('Only the latest changes can be undone')
    const turn = this.turnState(sessionId)
    if (turn.busy) throw new Error('Wait for the agent to finish before undoing')
    await turn.settling
    if (!(await this.deps.git.matchesSnapshot(created.cwd, changes.after))) {
      throw new Error('Files changed after that turn ended, so it cannot be undone safely')
    }
    const restored = await this.deps.git.restoreSnapshot(created.cwd, changes.before, changes.after)
    this.deps.store.append({ type: 'turn.reverted', sessionId, at: Date.now(), after })
    return { restored }
  }

  /** Pins a session to the top of the sidebar (or unpins it). */
  setPinned(sessionId: string, pinned: boolean): void {
    if (!this.createdEvent(sessionId)) throw new Error(`Unknown session: ${sessionId}`)
    this.deps.store.append({ type: 'session.pinned', sessionId, at: Date.now(), pinned })
  }

  /** A turn ended: send the next waiting message when it is clearly what the user wants. */
  private onTurnEnded(sessionId: string, reason: 'done' | 'cancelled' | 'error') {
    const turn = this.turnState(sessionId)
    turn.busy = false
    const next = turn.queue[0]
    if (!next) return
    const wanted = reason === 'done' || turn.sendAfterInterrupt === next.queueId
    if (!wanted) return
    const live = this.live.get(sessionId)
    if (!live) return
    turn.sendAfterInterrupt = undefined
    turn.queue.shift()
    this.dequeued(sessionId, next.queueId, 'sent')
    void this.startTurn(sessionId, live, next.text, next.attachments)
  }

  /** Waiting messages survive restarts: rebuild them from the log the first time they are needed. */
  private turnState(sessionId: string): TurnState {
    let state = this.turns.get(sessionId)
    if (!state) {
      const waiting = new Map<string, QueuedPrompt>()
      for (const { event } of this.deps.store.readSession(sessionId)) {
        if (event.type === 'prompt.queued') {
          waiting.set(event.queueId, {
            queueId: event.queueId,
            text: event.text,
            attachments: event.attachments ?? [],
          })
        } else if (event.type === 'prompt.dequeued') {
          waiting.delete(event.queueId)
        }
      }
      state = { busy: false, queue: [...waiting.values()] }
      this.turns.set(sessionId, state)
    }
    return state
  }

  async interrupt(sessionId: string): Promise<void> {
    this.dropAsks(sessionId)
    const { session } = this.requireLive(sessionId)
    // A stop pressed while the message is still on its way to the agent waits for it to arrive.
    await this.turnState(sessionId).starting
    return session.interrupt()
  }

  rename(sessionId: string, title: string): void {
    if (!this.createdEvent(sessionId)) throw new Error(`Unknown session: ${sessionId}`)
    this.deps.store.append({ type: 'session.renamed', sessionId, at: Date.now(), title })
  }

  /** Moves a session to the Done section (or back); only the sidebar looks at it. */
  setDone(sessionId: string, done: boolean): void {
    if (!this.createdEvent(sessionId)) throw new Error(`Unknown session: ${sessionId}`)
    this.deps.store.append({ type: 'session.done', sessionId, at: Date.now(), done })
  }

  /**
   * Removes a session: the agent stops, devices are told to drop it, and its events leave the log.
   * The folder and any worktree stay where they are.
   */
  async delete(sessionId: string): Promise<void> {
    if (!this.createdEvent(sessionId)) throw new Error(`Unknown session: ${sessionId}`)
    const live = this.live.get(sessionId)
    if (live) {
      this.live.delete(sessionId)
      this.dropAsks(sessionId)
      await live.session.close().catch(() => undefined)
    }
    this.turns.delete(sessionId)
    const { seq } = this.deps.store.append({ type: 'session.deleted', sessionId, at: Date.now() })
    this.deps.store.purgeSession(sessionId, seq)
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
    // Its turn snapshots go too (they live in the shared repository).
    await this.deps.git
      .dropSnapshots(created.cwd, `refs/beddcode/checkpoints/${sessionId}/`)
      .catch(() => {})
    this.checkpointRoots.delete(sessionId)
    return this.deps.git.removeWorktree(created.cwd)
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const { session, adapter } = this.requireLive(sessionId)
    await session.setPermissionMode(modeId)
    const created = this.createdEvent(sessionId)
    if (created) this.announceModes(sessionId, adapter, created.instanceId, modeId)
  }

  approve(sessionId: string, requestId: string, optionId: string): Promise<void> {
    const asked = this.hostAsks.get(requestId)
    if (asked && asked.sessionId === sessionId) {
      asked.settle(optionId === 'allow')
      return Promise.resolve()
    }
    return this.requireLive(sessionId).session.respondToApproval(requestId, optionId)
  }

  private readonly hostAsks = new Map<string, { sessionId: string; settle(allow: boolean): void }>()

  /**
   * Asks the user in the session's conversation, like an agent's own approval, for something the
   * host's tools are about to do. Resolves false when refused or left unanswered for `timeoutMs`.
   */
  askUser(
    sessionId: string,
    ask: { title: string; detail?: string; toolId?: string },
    timeoutMs = 4 * 60_000,
  ): Promise<boolean> {
    const requestId = `host-${randomUUID()}`
    return new Promise<boolean>((resolve) => {
      const settle = (allow: boolean) => {
        if (!this.hostAsks.delete(requestId)) return
        clearTimeout(timer)
        this.deps.store.append({
          type: 'approval.resolved',
          sessionId,
          at: Date.now(),
          requestId,
          optionId: allow ? 'allow' : 'deny',
        })
        resolve(allow)
      }
      const timer = setTimeout(() => settle(false), timeoutMs)
      timer.unref?.()
      this.hostAsks.set(requestId, { sessionId, settle })
      this.deps.store.append({
        type: 'approval.requested',
        sessionId,
        at: Date.now(),
        requestId,
        toolId: ask.toolId,
        title: ask.title,
        detail: ask.detail,
        options: [
          { id: 'allow', label: 'Allow', kind: 'allow' },
          { id: 'deny', label: 'Deny', kind: 'deny' },
        ],
      })
    })
  }

  /** Refuses whatever the host asked in a session, when its turn ends or it is stopped. */
  dropAsks(sessionId: string) {
    for (const asked of this.hostAsks.values())
      if (asked.sessionId === sessionId) asked.settle(false)
  }

  async close() {
    // Messages still on their way to the agent, and snapshots still being taken, finish first.
    await Promise.allSettled(
      [...this.turns.values()].flatMap((t) => [t.starting, t.taking, t.settling]),
    )
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

    // Continue with the model last chosen, not the one the session started with.
    const lastModel = events.map((e) => e.event).findLast((e) => e.type === 'session.model')
    const chosen = lastModel?.type === 'session.model' ? lastModel : created.event

    const session = await adapter.startSession(instance.id, {
      sessionId,
      cwd: created.event.cwd,
      additionalDirectories: [this.deps.attachments.root],
      permissionMode: mode,
      model: chosen.model,
      effort: chosen.effort,
      resumeId,
      mcpServers: this.toolServersFor(
        sessionId,
        created.event.agentTools || created.event.browserTools || created.event.designTools,
      ),
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

  private toolServersFor(sessionId: string, wanted: boolean | undefined) {
    return wanted && this.deps.agentToolServers ? this.deps.agentToolServers(sessionId) : undefined
  }

  /** A turn is running, or about to. */
  isBusy(sessionId: string): boolean {
    return this.turns.get(sessionId)?.busy ?? false
  }

  /** The permission mode the session is in now, and the modes it could be in. */
  currentMode(sessionId: string): string | undefined {
    let mode: string | undefined
    for (const { event } of this.deps.store.readSession(sessionId)) {
      if (event.type === 'session.created') mode = event.permissionMode
      else if (event.type === 'session.modes' && event.currentModeId) mode = event.currentModeId
    }
    return mode
  }

  /** How a session was created (its folder, branch, agent). */
  sessionInfo(sessionId: string) {
    return this.createdEvent(sessionId)
  }

  private createdEvent(sessionId: string) {
    for (const { event } of this.deps.store.readSession(sessionId)) {
      if (event.type === 'session.created') return event
    }
    return undefined
  }

  /** Conversations the agent's CLI has stored, marking the ones that are already sessions here. */
  async listHistory(instanceId: string, cwd?: string): Promise<HistoryEntry[]> {
    const { adapter, instance } = await this.findInstance(instanceId)
    if (!adapter.listHistory)
      throw new Error(`${instance.label} does not keep a history we can read`)
    const known = this.sessionsByProviderId()
    const items = await adapter.listHistory(instance.id, cwd)
    return items.map((item) => ({ ...item, imported: known.has(item.id) }))
  }

  /** Brings a stored conversation in as a session; the agent resumes it on the first message. */
  async importSession(params: RpcParams<'sessions.import'>): Promise<{ sessionId: string }> {
    // Opening the same conversation again goes back to the session it already is.
    const existing = this.sessionsByProviderId().get(params.providerSessionId)
    if (existing) return { sessionId: existing }
    const { adapter, instance } = await this.findInstance(params.instanceId)
    if (!adapter.readHistory || !adapter.capabilities(instance.id).resume) {
      throw new Error(`${instance.label} cannot continue earlier conversations`)
    }
    const listed = (await adapter.listHistory?.(instance.id, params.cwd))?.find(
      (h) => h.id === params.providerSessionId,
    )
    const folder = params.cwd ?? listed?.cwd ?? this.deps.defaultCwd
    if (!isDirectory(folder)) throw new Error(`Folder does not exist: ${folder}`)
    const turns = await adapter.readHistory(instance.id, params.providerSessionId, folder)

    const info = await this.deps.git.info(folder).catch(() => null)
    const sessionId = randomUUID()
    const projectPath = info?.isRepo ? (info.mainRoot ?? info.root ?? folder) : folder
    const at = listed?.updatedAt ?? Date.now()
    this.deps.store.append({
      type: 'session.created',
      sessionId,
      at,
      title: listed?.title || defaultTitle(projectPath),
      cwd: folder,
      projectPath,
      branch: info?.isRepo ? info.branch : undefined,
      instanceId: instance.id,
      imported: true,
    })
    this.appendTurns(sessionId, turns, at)
    this.deps.store.append({
      type: 'session.provider-session',
      sessionId,
      at: Date.now(),
      providerSessionId: params.providerSessionId,
    })
    this.announceModes(sessionId, adapter, instance.id, undefined)
    return { sessionId }
  }

  /** A new session that continues an existing one, optionally only its first `throughTurn` turns. */
  async fork(params: RpcParams<'sessions.fork'>): Promise<{ sessionId: string }> {
    const events = this.deps.store.readSession(params.sessionId)
    const created = events.find((e) => e.event.type === 'session.created')?.event
    if (created?.type !== 'session.created') throw new Error(`Unknown session: ${params.sessionId}`)
    const providerSession = events
      .map((e) => e.event)
      .findLast((e) => e.type === 'session.provider-session')
    if (providerSession?.type !== 'session.provider-session') {
      throw new Error('Send a first message before forking this session')
    }
    const { adapter, instance } = await this.findInstance(created.instanceId)
    if (!adapter.forkHistory || !adapter.capabilities(instance.id).fork) {
      throw new Error(`${instance.label} cannot fork a conversation`)
    }

    // Keep everything up to the end of the chosen turn.
    let kept = events.map((e) => e.event).filter((e) => e.type !== 'session.created')
    if (params.throughTurn !== undefined) {
      let completed = 0
      const end = kept.findIndex(
        (e) => e.type === 'turn.completed' && ++completed === params.throughTurn,
      )
      if (end < 0) throw new Error(`This session has fewer than ${params.throughTurn} turns`)
      kept = kept.slice(0, end + 1)
    }

    const newProviderId = await adapter.forkHistory(instance.id, {
      providerSessionId: providerSession.providerSessionId,
      cwd: created.cwd,
      throughTurn: params.throughTurn,
    })

    const sessionId = randomUUID()
    this.deps.store.append({
      ...created,
      sessionId,
      at: Date.now(),
      title: params.title ?? `${created.title} (fork)`,
      forkedFrom: { sessionId: params.sessionId, title: created.title },
      imported: undefined,
    })
    // What was said so far stays visible; open approvals, queues and mode changes do not carry over.
    const carried = new Set([
      'message.delta',
      'tool.started',
      'tool.updated',
      'tool.completed',
      'diff',
      'plan.updated',
      'turn.started',
      'turn.completed',
    ])
    for (const event of kept) {
      if (carried.has(event.type)) this.deps.store.append({ ...event, sessionId })
    }
    this.deps.store.append({
      type: 'session.provider-session',
      sessionId,
      at: Date.now(),
      providerSessionId: newProviderId,
    })
    const lastModes = events.map((e) => e.event).findLast((e) => e.type === 'session.modes')
    this.announceModes(
      sessionId,
      adapter,
      instance.id,
      lastModes?.type === 'session.modes' ? lastModes.currentModeId : created.permissionMode,
    )
    return { sessionId }
  }

  /**
   * What an agent offers before a session exists. Claude and Codex answer from their capabilities;
   * ACP agents are probed once and remembered (a real session seeds the same cache).
   */
  async previewAgent(instanceId: string, cwd?: string): Promise<AgentPreview> {
    const { adapter, instance } = await this.findInstance(instanceId)
    const cached = this.deps.previews?.get(instance.id)
    if (cached) {
      // Agents update themselves (Grok does), so an old answer is checked again: the fresh one is
      // used when it comes quickly, else the old one now and the fresh one next time.
      const age = this.deps.previews?.ageOf(instance.id) ?? 0
      if (!adapter.preview || age <= PREVIEW_REFRESH_MS) return cached
      const fresh = this.refreshPreview(instance.id, cwd)
      const late = new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), PREVIEW_REFRESH_WAIT_MS).unref?.()
      })
      return (await Promise.race([fresh, late])) ?? cached
    }
    if (!adapter.preview) {
      return {
        modes: instance.capabilities.permissionModes,
        config: [],
        commands:
          (await adapter.listCommands?.(
            instance.id,
            cwd ?? (await this.scratchFolder('_preview')),
          )) ?? [],
      }
    }
    const preview = await adapter.preview(
      instance.id,
      cwd ?? (await this.scratchFolder('_preview')),
    )
    this.deps.previews?.set(instance.id, preview)
    return preview
  }

  private readonly refreshing = new Map<string, Promise<AgentPreview | undefined>>()
  /** Probes an agent again and remembers the answer; one probe per agent at a time. */
  private refreshPreview(instanceId: string, cwd?: string): Promise<AgentPreview | undefined> {
    const running = this.refreshing.get(instanceId)
    if (running) return running
    const probe = this.findInstance(instanceId)
      .then(async ({ adapter }) =>
        adapter.preview?.(instanceId, cwd ?? (await this.scratchFolder('_preview'))),
      )
      .then(
        (preview) => {
          if (preview) this.deps.previews?.set(instanceId, preview)
          return preview
        },
        (err: unknown) => {
          this.deps.log.warn(`could not refresh the preview of ${instanceId}`, err)
          return undefined
        },
      )
      .finally(() => this.refreshing.delete(instanceId))
    this.refreshing.set(instanceId, probe)
    return probe
  }

  /** Forget what was remembered for an agent, e.g. after it was removed or re-added. */
  forgetPreview(instanceId: string) {
    this.deps.previews?.clear(instanceId)
  }

  /** What real ACP sessions report about themselves refreshes the cached preview. */
  private readonly seeds = new PreviewSeeds()
  private seedPreview(sessionId: string, event: SessionEvent) {
    const previews = this.deps.previews
    if (!previews) return
    const preview = this.seeds.observe(
      sessionId,
      event,
      () =>
        this.deps.store.readSession(sessionId).filter((e) => e.event.type === 'turn.started')
          .length === 1,
    )
    if (!preview || this.live.get(sessionId)?.adapter.kind !== 'acp') return
    const created = this.createdEvent(sessionId)
    if (created) previews.set(created.instanceId, preview)
  }

  async listCommands(instanceId: string, cwd?: string): Promise<SlashCommand[]> {
    const { adapter } = await this.findInstance(instanceId)
    return (
      (await adapter.listCommands?.(instanceId, cwd ?? (await this.scratchFolder('_preview')))) ??
      []
    )
  }

  async mcp(instanceId: string) {
    const { adapter, instance } = await this.findInstance(instanceId)
    if (!adapter.mcp) throw new Error(`${instance.label} has no MCP settings we can manage`)
    return {
      list: (cwd?: string): Promise<McpServer[]> =>
        adapter.mcp!.list(instance.id, cwd ?? this.deps.defaultCwd),
      add: (server: McpServerInput, cwd?: string) =>
        adapter.mcp!.add(instance.id, server, cwd ?? this.deps.defaultCwd),
      remove: (name: string, scope?: string, cwd?: string) =>
        adapter.mcp!.remove(instance.id, name, scope, cwd ?? this.deps.defaultCwd),
    }
  }

  /** Writes stored exchanges into the log the way a live conversation would have. */
  private appendTurns(sessionId: string, turns: HistoryTurn[], at: number) {
    turns.forEach((turn, index) => {
      const events: SessionEvent[] = []
      const turnId = `turn-${index + 1}`
      const base = { sessionId, at, turnId }
      events.push({ ...base, type: 'message.delta', role: 'user', text: turn.user })
      events.push({ ...base, type: 'turn.started' })
      if (turn.events?.length) {
        // Tool ids only have to be unique within a turn where they came from.
        const open = new Set<string>()
        let last = at
        for (const event of turn.events) {
          const toolId = 'toolId' in event ? { toolId: `${turnId}:${event.toolId}` } : {}
          // Keep the time the agent's own record gives, so tool calls show how long they took.
          if (event.at > 0) last = event.at
          if (event.type === 'tool.started') open.add(event.toolId)
          if (event.type === 'tool.completed') open.delete(event.toolId)
          events.push({ ...event, ...toolId, ...base, at: last } as SessionEvent)
        }
        // A tool still running when the conversation was stored never finished; it must not spin.
        for (const toolId of open) {
          events.push({
            ...base,
            at: last,
            type: 'tool.completed',
            toolId: `${turnId}:${toolId}`,
            ok: false,
          })
        }
      } else if (turn.assistant) {
        events.push({
          ...base,
          type: 'message.delta',
          role: 'assistant',
          text: turn.assistant,
        })
      }
      events.push({ ...base, type: 'turn.completed', reason: 'done' })
      this.deps.store.appendMany(events)
    })
  }

  /** Which session holds each provider conversation (the newest wins), so history can mark them. */
  private sessionsByProviderId(): Map<string, string> {
    const ids = new Map<string, string>()
    let cursor = 0
    for (;;) {
      const batch = this.deps.store.readAfter(cursor, 1000)
      for (const { event } of batch) {
        if (event.type === 'session.provider-session')
          ids.set(event.providerSessionId, event.sessionId)
      }
      if (batch.length < 1000) break
      cursor = batch.at(-1)!.seq
    }
    return ids
  }

  /** Copies the provider's normalized events into the durable log. */
  private async pump(sessionId: string, session: ProviderSession) {
    try {
      for await (const event of session.events) {
        this.deps.store.append(event)
        this.seedPreview(sessionId, event)
        if (event.type === 'turn.started') this.turnState(sessionId).busy = true
        if (event.type === 'turn.completed') {
          const turn = this.turnState(sessionId)
          if (turn.before || turn.taking) {
            const settling = this.recordTurnChanges(sessionId, turn, event.turnId)
            turn.settling = settling
            void settling.finally(() => {
              if (turn.settling === settling) turn.settling = undefined
            })
          }
          this.onTurnEnded(sessionId, event.reason)
        }
      }
    } catch (err) {
      this.deps.log.error(`event stream failed for ${sessionId}`, err)
    } finally {
      if (this.live.get(sessionId)?.session === session) {
        this.live.delete(sessionId)
        // A session whose process ended is no longer in the middle of a turn.
        const turn = this.turns.get(sessionId)
        if (turn) turn.busy = false
      }
    }
  }
}

/** What the provider receives: the text (naming the files) and the files themselves. */
function promptInput(text: string, attachments: { path: string }[]) {
  return {
    text: withAttachments(text, attachments),
    attachments: attachments.length > 0 ? attachments.map((a) => a.path) : undefined,
  }
}

/** Agents read attachments from disk, so the prompt names each file's absolute path. */
function withAttachments(text: string, attachments: { path: string }[]): string {
  return attachments.length === 0
    ? text
    : `${text}\n\nAttached files:\n${attachments.map((a) => `- ${a.path}`).join('\n')}`.trim()
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
