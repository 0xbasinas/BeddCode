import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
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
  StartSessionInput,
} from '@beddcode/provider-core'
import { withTimeout, type Logger } from '@beddcode/shared'
import { PreviewSeeds, type PreviewCache } from '../agents/previews.ts'
import type { AttachmentStore } from '../attachments/store.ts'
import type { EventStore } from '../store/eventStore.ts'
import { summarizeUsage } from '../usage/summary.ts'
import type { GitService } from '../workspace/git.ts'
import type { AgentTerminals } from '../terminals/agentTerminals.ts'

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
  /** Shows the commands agents run in the Terminal pane (and runs ACP agents' commands there). */
  agentTerminals?: AgentTerminals
  /**
   * A running turn whose agent sends nothing for this long, while no tool is running and nothing
   * waits for the user, is stopped with an explanation. Agents on stdio can hang mid-stream
   * without exiting. Default 15 minutes; 0 turns the check off. `BEDDCODE_TURN_STALL_MS` too.
   */
  stallMs?: number
  /**
   * The same for a turn whose tool runs this long with no word from the agent at all: builds and
   * test runs are quiet, but not for hours. Default 2 hours; 0 turns it off.
   * `BEDDCODE_TOOL_STALL_MS` too.
   */
  toolStallMs?: number
}

/** Where a session came from, when not straight from the user. */
export interface SessionOrigin {
  parent?: { sessionId: string; depth: number; requestId?: string }
  schedule?: { id: string; name: string }
  mcpGateway?: boolean
}

interface LiveSession {
  session: ProviderSession
  adapter: ProviderAdapter
  /** How it was started, to start it again without the conversation if that turns out lost. */
  instanceId?: string
  label?: string
  input?: StartSessionInput
  /** The conversation it was asked to resume, until the agent shows it really has it. */
  resumedFrom?: string
  /** The agent has answered since it resumed, so the conversation is there. */
  confirmed?: boolean
  /** A turn is already open in the log for this process's first `turn.started`. */
  skipTurnStart?: boolean
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
  /** The user (or another agent) pressed stop on the running turn. */
  stopRequested?: boolean
  /** What the running turn was started with, to send again in a new conversation if need be. */
  lastPrompt?: { text: string; attachments: { name: string; path: string }[] }
  /** The agent reported the running turn as started. */
  agentStarted?: boolean
}

/** What the host watches of a live session to tell a stalled agent from a busy one. */
interface Activity {
  /** Monotonic time (see `now`): a clock change or a sleeping laptop must not look like silence. */
  lastAt: number
  /** Tools started and not finished: a long build is quiet but not stuck. */
  tools: Set<string>
  /** Approvals and questions waiting for the user. */
  waiting: Set<string>
  /** The "no" options of open approvals, to tell when the user turned one down. */
  denials: Map<string, Set<string>>
  /** The user turned a request down this turn; some agents (Grok) then end the turn as cancelled. */
  declined?: boolean
  stalled?: boolean
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
  private readonly activity = new Map<string, Activity>()
  private stallTimer: ReturnType<typeof setInterval> | undefined
  /** Answers to messages sent with a client id, so a resend is not sent twice (see prompt). */
  private readonly recentSends = new Map<string, Promise<RpcResult<'sessions.prompt'>>>()
  /** Events that must reach the log but that the database refused (see `record`). */
  private readonly unsaved: SessionEvent[] = []
  private storeFailedAt = -Infinity
  /** Set while the host shuts down: agents ending then is expected, not a failure. */
  private closing = false
  /** Agents the host itself closed (stalled, deleted): their failing prompt is no news. */
  private readonly closedOnPurpose = new WeakSet<ProviderSession>()
  /** Agents that could not find the conversation they resumed: the rest of their stream is dropped. */
  private readonly lostStreams = new WeakSet<ProviderSession>()
  private detected: {
    at: number
    instances: { adapter: ProviderAdapter; instance: ProviderInstance }[]
  } | null = null
  private readonly gitGenerations = new Set<string>()

  constructor(private readonly deps: SessionManagerDeps) {
    // Also retries events the database refused, so it runs even with both stall limits off.
    const limits = [this.stallMs, this.toolStallMs].filter((ms) => ms > 0)
    const every = Math.max(10, Math.min(30_000, ...limits.map((ms) => ms / 4)))
    this.stallTimer = setInterval(() => this.checkStalls(), every)
    this.stallTimer.unref?.()
  }

  private get stallMs(): number {
    return this.deps.stallMs ?? envMs('BEDDCODE_TURN_STALL_MS', 15 * 60_000)
  }

  private get toolStallMs(): number {
    return this.deps.toolStallMs ?? envMs('BEDDCODE_TOOL_STALL_MS', 2 * 60 * 60_000)
  }

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
    let worktree: { baseBranch: string; copiedFiles?: number } | undefined
    if (params.workspace?.mode === 'local' && params.workspace.newBranch?.trim()) {
      if (!info?.isRepo) throw new Error('Branches need a git repository')
      await this.deps.git.createBranch(
        folder,
        params.workspace.newBranch,
        params.workspace.baseBranch,
      )
      branch = params.workspace.newBranch.trim()
    }
    if (params.workspace?.mode === 'worktree') {
      if (!info?.isRepo) throw new Error('Worktrees need a git repository')
      const made = await this.deps.git.createWorktree(folder, {
        branch: params.workspace.branch,
        baseBranch: params.workspace.baseBranch,
        name: params.workspace.name,
      })
      cwd = made.path
      branch = made.branch
      worktree = {
        baseBranch: made.baseBranch,
        ...(made.copiedFiles ? { copiedFiles: made.copiedFiles } : {}),
      }
    }

    let session: ProviderSession
    try {
      session = await adapter.startSession(instance.id, {
        sessionId,
        cwd,
        terminalHost: this.agentTerminal(sessionId, cwd, adapter, instance, params.title),
        additionalDirectories: [this.deps.attachments.root],
        permissionMode: params.permissionMode,
        model: params.model,
        effort: params.effort,
        config: params.config,
        mcpServers: this.toolServersFor(
          sessionId,
          params.agentTools ||
            params.browserTools ||
            params.designTools ||
            params.computerTools ||
            params.linearTools,
        ),
      })
    } catch (err) {
      // Do not leave an unused worktree behind when the agent could not start.
      if (worktree) await this.deps.git.removeWorktree(cwd).catch(() => false)
      // Remove only an empty folder; preserve any files the agent wrote before failing.
      if (params.projectless) await rmdir(folder).catch(() => {})
      throw err
    }
    this.live.set(sessionId, { session, adapter, instanceId: instance.id, label: instance.label })

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
      mcpGateway: origin.mcpGateway,
      agentTools: (params.agentTools && this.deps.agentToolServers !== undefined) || undefined,
      browserTools: (params.browserTools && this.deps.agentToolServers !== undefined) || undefined,
      designTools: (params.designTools && this.deps.agentToolServers !== undefined) || undefined,
      computerTools:
        (params.computerTools && this.deps.agentToolServers !== undefined) || undefined,
      linearTools: (params.linearTools && this.deps.agentToolServers !== undefined) || undefined,
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

  /**
   * Sends a message. `clientMessageId` makes it safe to send again: a client that lost its
   * connection before the answer, or a double press of Send, gets the first answer back instead of
   * the message going to the agent twice.
   */
  async prompt(
    sessionId: string,
    text: string,
    attachmentIds: string[] = [],
    mode: 'auto' | 'queue' = 'auto',
    clientMessageId?: string,
  ): Promise<RpcResult<'sessions.prompt'>> {
    if (!clientMessageId) return this.sendPrompt(sessionId, text, attachmentIds, mode)
    const key = `${sessionId}\u0000${clientMessageId}`
    const sent = this.recentSends.get(key)
    if (sent) {
      this.deps.log.info(`${sessionId}: the same message was sent again; answering it once`)
      return sent
    }
    const result = this.sendPrompt(sessionId, text, attachmentIds, mode)
    this.recentSends.set(key, result)
    // Only a few minutes and a few hundred messages are remembered: a resend comes right away.
    setTimeout(() => this.recentSends.delete(key), 10 * 60_000).unref?.()
    if (this.recentSends.size > 500) {
      const oldest = this.recentSends.keys().next().value
      if (oldest !== undefined) this.recentSends.delete(oldest)
    }
    // A message that failed was not sent: trying again must really try again.
    result.catch(() => {
      if (this.recentSends.get(key) === result) this.recentSends.delete(key)
    })
    return result
  }

  private async sendPrompt(
    sessionId: string,
    text: string,
    attachmentIds: string[],
    mode: 'auto' | 'queue',
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

    // Stop was pressed and the turn has not ended yet: this message is what the user wants next,
    // not more input for the turn being stopped (which could swallow it). Send it once it ends.
    const afterStop = turn.stopRequested === true
    // The agent is working. Steer the message into the running turn when it can take it there,
    // otherwise keep it for after the turn.
    if (mode === 'auto' && live.session.steer && !afterStop) {
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
    if (afterStop && turn.queue.length === 0) turn.sendAfterInterrupt = queueId
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
    turn.stopRequested = false
    turn.lastPrompt = { text, attachments }
    turn.agentStarted = false
    this.touch(sessionId)
    this.appendUserMessage(sessionId, text, attachments)
    const failed = (err: unknown) => this.promptFailed(sessionId, session, err)
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

  /** The agent did not take a message, or its turn failed before the agent could say why. */
  private promptFailed(sessionId: string, session: ProviderSession, err: unknown) {
    const turn = this.turnState(sessionId)
    // Another process has the session by now (a new conversation replaced a lost one).
    if (this.live.get(sessionId) && this.live.get(sessionId)?.session !== session) return
    turn.busy = false
    turn.before = undefined
    // The host is shutting down or closed the agent itself: the next start closes the turn with
    // that reason (see recovery.ts). An "error: session closed" here would hide it.
    if (this.closing || this.closedOnPurpose.has(session) || this.lostStreams.has(session)) {
      this.deps.log.debug(`prompt for ${sessionId} ended with its agent: ${errorText(err)}`)
      return
    }
    const gone = !this.live.has(sessionId)
    // The process died mid-turn: closing that turn, with the reason, is `endOrphanedTurn`'s job.
    if (gone && turn.agentStarted) {
      this.deps.log.debug(`prompt for ${sessionId} ended with its agent: ${errorText(err)}`)
      return
    }
    this.deps.log.error(`prompt failed for ${sessionId}`, err)
    try {
      this.deps.store.append({
        type: 'error',
        sessionId,
        at: Date.now(),
        message: gone
          ? `The agent stopped before it could take this message (${errorText(err)}). Send it again to start the agent anew.`
          : withHint(errorText(err)),
      })
    } catch (appendErr) {
      this.deps.log.error(`could not record the failure of ${sessionId}`, appendErr)
    }
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

  /**
   * Stops the current turn. Sessions this one's agent started keep working unless asked, because
   * stopping a turn is often just a change of direction; `includeChildren` stops them too.
   */
  async interrupt(sessionId: string, options: { includeChildren?: boolean } = {}): Promise<void> {
    const stopChildren = options.includeChildren
      ? this.descendants(sessionId).map((id) => this.interruptOne(id).catch(() => undefined))
      : []
    await this.interruptOne(sessionId)
    await Promise.all(stopChildren)
  }

  private async interruptOne(sessionId: string): Promise<void> {
    this.dropAsks(sessionId)
    const { session } = this.requireLive(sessionId)
    this.turnState(sessionId).stopRequested = true
    // A stop pressed while the message is still on its way to the agent waits for it to arrive.
    await this.turnState(sessionId).starting
    return session.interrupt()
  }

  /** Every session started, directly or not, by this session's agent that is still live. */
  private descendants(sessionId: string): string[] {
    const found: string[] = []
    const queue = [sessionId]
    while (queue.length > 0) {
      for (const child of this.deps.store.childrenOf(queue.shift()!)) {
        if (child === sessionId || found.includes(child)) continue
        found.push(child)
        queue.push(child)
      }
    }
    return found.filter((id) => this.live.has(id))
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
    // Nothing is left working for a session that no longer exists.
    for (const id of this.descendants(sessionId))
      await this.interruptOne(id).catch((err: unknown) =>
        this.deps.log.warn(`could not stop ${id} while deleting ${sessionId}`, err),
      )
    const live = this.live.get(sessionId)
    if (live) {
      this.live.delete(sessionId)
      this.dropAsks(sessionId)
      this.closedOnPurpose.add(live.session)
      // The session goes either way; a stuck agent must not hold the delete up.
      await withTimeout(live.session.close(), 5_000, 'closing the agent').catch((err: unknown) =>
        this.deps.log.warn(`could not close the agent of ${sessionId} cleanly`, err),
      )
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
      this.live.delete(sessionId)
      this.closedOnPurpose.add(live.session)
      await withTimeout(live.session.close(), 5_000, 'closing the agent').catch((err: unknown) =>
        this.deps.log.warn(`could not close the agent of ${sessionId} cleanly`, err),
      )
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
    this.closing = true
    if (this.stallTimer) clearInterval(this.stallTimer)
    // Messages still on their way to the agent, and snapshots still being taken, finish first.
    await Promise.allSettled(
      [...this.turns.values()].flatMap((t) => [t.starting, t.taking, t.settling]),
    )
    // One agent that will not close must not hold up the others, or the host's exit.
    await Promise.allSettled(
      [...this.live.entries()].map(([sessionId, l]) =>
        withTimeout(l.session.close(), 3_000).catch((err: unknown) =>
          this.deps.log.warn(`could not close ${sessionId} cleanly`, err),
        ),
      ),
    )
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
    let found = (await this.detect()).find((d) => d.instance.id === instanceId)
    // Detection is cached: an agent installed or signed in a moment ago is looked for again.
    if (found?.instance.status !== 'ready')
      found = (await this.detect(true)).find((d) => d.instance.id === instanceId)
    if (!found) throw new Error(`Unknown provider instance: ${instanceId}`)
    const { label, status } = found.instance
    if (status === 'not-installed') {
      throw new Error(
        `${label} is not ready: it is not installed on the host computer, or not on the host's PATH. Install it there, then try again.`,
      )
    }
    if (status === 'needs-sign-in') {
      throw new Error(
        `${label} is not ready: it needs you to sign in on the host computer. Sign in there, then try again.`,
      )
    }
    if (status !== 'ready') throw new Error(`${label} is not ready (${status})`)
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

    // A deleted worktree or a project folder that was moved: say so, instead of the agent failing
    // to start with a bare ENOENT.
    if (!isDirectory(created.event.cwd)) {
      throw new Error(
        created.event.worktree
          ? `This session's worktree no longer exists (${created.event.cwd}). Its history is kept; start a new session to keep working.`
          : `This session's folder no longer exists (${created.event.cwd}). Restore it, or start a new session.`,
      )
    }
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

    const renamed = events.map((e) => e.event).findLast((e) => e.type === 'session.renamed')
    const input = {
      sessionId,
      cwd: created.event.cwd,
      terminalHost: this.agentTerminal(
        sessionId,
        created.event.cwd,
        adapter,
        instance,
        renamed?.type === 'session.renamed' ? renamed.title : created.event.title,
      ),
      additionalDirectories: [this.deps.attachments.root],
      permissionMode: mode,
      model: chosen.model,
      effort: chosen.effort,
      mcpServers: this.toolServersFor(
        sessionId,
        created.event.agentTools ||
          created.event.browserTools ||
          created.event.designTools ||
          created.event.computerTools ||
          created.event.linearTools,
      ),
    }
    let session: ProviderSession
    let resumedFrom: string | undefined = resumeId
    try {
      session = await adapter.startSession(instance.id, { ...input, resumeId })
    } catch (err) {
      // The agent lost its copy of the conversation (cleaned up, or cut short by a crash mid-write).
      // Keep the session usable: continue in a new conversation and say what was lost.
      if (!isLostConversation(err)) throw new Error(withHint(errorText(err)), { cause: err })
      this.deps.log.warn(`${instance.label} could not resume ${sessionId}; starting fresh`, err)
      session = await adapter.startSession(instance.id, input)
      resumedFrom = undefined
      this.deps.store.append({
        type: 'error',
        sessionId,
        at: Date.now(),
        message: lostConversationText(instance.label, errorText(err)),
      })
    }
    const live: LiveSession = {
      session,
      adapter,
      instanceId: instance.id,
      label: instance.label,
      input,
      resumedFrom,
    }
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

  /** The session's agent terminal; ACP agents run their commands in it. */
  private agentTerminal(
    sessionId: string,
    cwd: string,
    adapter: ProviderAdapter,
    instance: { id: string; label: string },
    title?: string,
  ) {
    const host = this.deps.agentTerminals?.register({
      sessionId,
      cwd,
      label: instance.label,
      instanceId: instance.id,
      title,
      hostsCommands: adapter.kind === 'acp',
    })
    return adapter.kind === 'acp' ? host : undefined
  }

  /** Copies the provider's normalized events into the durable log. */
  private async pump(sessionId: string, session: ProviderSession) {
    let failure: unknown
    this.activity.set(sessionId, {
      lastAt: now(),
      tools: new Set(),
      waiting: new Set(),
      denials: new Map(),
    })
    try {
      for await (const raw of session.events) {
        if (this.lostStreams.has(session)) continue
        const live = this.live.get(sessionId)
        if (live?.session === session && live.resumedFrom && !live.confirmed) {
          // Some agents (Claude) only find out at the first message that the conversation they
          // resumed is gone. Continue in a new one and send that message again.
          if (raw.type === 'error' && isLostConversation(raw.message)) {
            this.lostStreams.add(session)
            void this.continueFresh(sessionId, live, raw.message)
            continue
          }
          if (confirmsConversation(raw)) live.confirmed = true
        }
        if (raw.type === 'turn.started') this.turnState(sessionId).agentStarted = true
        if (raw.type === 'turn.started' && live?.session === session && live.skipTurnStart) {
          // The turn this answers is already open in the log.
          live.skipTurnStart = false
          this.observe(sessionId, raw)
          continue
        }
        const event = this.explain(sessionId, raw)
        this.deps.agentTerminals?.observe(event)
        // Live command output is for the agent terminal only; the tool's result keeps the output.
        if (event.type === 'tool.output') continue
        this.record(event)
        this.observe(sessionId, event)
        this.seedPreview(sessionId, event)
        if (event.type === 'turn.started') this.turnState(sessionId).busy = true
        if (event.type === 'turn.completed') {
          const turn = this.turnState(sessionId)
          turn.stopRequested = false
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
      failure = err
      this.deps.log.error(`event stream failed for ${sessionId}`, err)
    } finally {
      if (this.live.get(sessionId)?.session === session && !this.lostStreams.has(session)) {
        this.live.delete(sessionId)
        this.deps.agentTerminals?.ended(sessionId)
        this.activity.delete(sessionId)
        // A session whose process ended is no longer in the middle of a turn.
        const turn = this.turns.get(sessionId)
        if (turn) turn.busy = false
        if (!this.closing) this.endOrphanedTurn(sessionId, failure)
      }
    }
  }

  /**
   * Saves an agent event. A full disk or a locked database loses the event rather than the whole
   * stream (which would leave the session looking stuck); the ones that open and close turns or
   * name the conversation are kept and saved once the database takes writes again, so no turn
   * stays "running" forever and the next resume finds the conversation.
   */
  private record(event: SessionEvent) {
    if (this.unsaved.length > 0 && !this.saveUnsaved()) {
      this.keepUnsaved(event)
      return
    }
    try {
      this.deps.store.append(event)
    } catch (err) {
      this.keepUnsaved(event)
      const at = now()
      if (at - this.storeFailedAt > 60_000) {
        this.storeFailedAt = at
        this.deps.log.error(`could not record ${event.type} for ${event.sessionId}`, err)
      }
    }
  }

  private keepUnsaved(event: SessionEvent) {
    if (!MUST_SAVE.has(event.type)) return
    this.unsaved.push(event)
    if (this.unsaved.length > 1_000) this.unsaved.shift()
  }

  /** Saves the events kept by `record`; false while the database still refuses them. */
  private saveUnsaved(): boolean {
    while (this.unsaved.length > 0) {
      try {
        this.deps.store.append(this.unsaved[0]!)
      } catch {
        return false
      }
      this.unsaved.shift()
    }
    this.deps.log.info('the database takes writes again; saved the events kept meanwhile')
    return true
  }

  /**
   * The agent resumed without complaint but then could not find the conversation. Replaces its
   * process with one in a new conversation, says so, and gives it the message again; the turn the
   * user sees just carries on.
   */
  private async continueFresh(sessionId: string, old: LiveSession, reason: string) {
    this.closedOnPurpose.add(old.session)
    void withTimeout(old.session.close(), 5_000).catch(() => undefined)
    const turn = this.turnState(sessionId)
    const label = old.label ?? 'The agent'
    this.deps.log.warn(`${label} lost the conversation of ${sessionId} (${reason}); starting fresh`)
    try {
      if (!old.input || !old.instanceId) throw new Error(reason)
      const session = await old.adapter.startSession(old.instanceId, old.input)
      if (this.live.get(sessionId) !== old || this.closing) {
        // Deleted, or the host is stopping, while the new process started.
        this.closedOnPurpose.add(session)
        await session.close().catch(() => undefined)
        return
      }
      const resend = turn.busy ? turn.lastPrompt : undefined
      const live: LiveSession = { ...old, session, resumedFrom: undefined, skipTurnStart: !!resend }
      this.live.set(sessionId, live)
      void this.pump(sessionId, session)
      this.deps.store.append({
        type: 'error',
        sessionId,
        at: Date.now(),
        message: lostConversationText(label, reason),
      })
      if (resend) {
        this.touch(sessionId)
        session
          .prompt(promptInput(resend.text, resend.attachments))
          .catch((err: unknown) => this.promptFailed(sessionId, session, err))
      }
    } catch (err) {
      this.deps.log.error(`could not continue ${sessionId} in a new conversation`, err)
      if (this.live.get(sessionId) === old) {
        this.live.delete(sessionId)
        this.activity.delete(sessionId)
      }
      turn.busy = false
      this.endOrphanedTurn(
        sessionId,
        new Error(`${reason}; a new conversation did not start either (${errorText(err)})`),
      )
    }
  }

  /**
   * The agent's process ended (crashed, was killed, ran out of memory) while a turn was still
   * open in the log, and its adapter did not close the turn. Without this the session would show
   * "running" until the host restarts. The next message resumes the conversation in a new process.
   */
  private endOrphanedTurn(sessionId: string, failure: unknown) {
    // The last turn the log started and did not complete, and whether it already says what went
    // wrong (the agent's own error, or the stall check).
    let open: { turnId?: string; explained: boolean } | undefined
    try {
      for (const { event } of this.deps.store.readSession(sessionId)) {
        if (event.type === 'turn.started') open = { turnId: event.turnId, explained: false }
        else if (event.type === 'turn.completed') open = undefined
        else if (event.type === 'error' && open) open.explained = true
      }
    } catch {
      return
    }
    if (!open) return
    const why = failure ? `: ${errorText(failure)}` : ''
    const at = Date.now()
    try {
      if (!open.explained) {
        this.deps.store.append({
          type: 'error',
          sessionId,
          turnId: open.turnId,
          at,
          message: `The agent stopped unexpectedly${why}. Send a message to continue; the conversation is resumed in a new process.`,
        })
      }
      this.deps.store.append({
        type: 'turn.completed',
        sessionId,
        turnId: open.turnId,
        at,
        reason: 'error',
      })
    } catch (err) {
      this.deps.log.error(`could not close the open turn of ${sessionId}`, err)
    }
  }

  /**
   * Gives a turn that ended as "cancelled" its reason when the agent did not say one. Nobody
   * pressed stop, so the agent (or its model provider) ended it on its own; a bare "cancelled"
   * reads as if the user did.
   */
  private explain(sessionId: string, event: SessionEvent): SessionEvent {
    if (event.type === 'error') {
      const message = withHint(event.message)
      return message === event.message ? event : { ...event, message }
    }
    if (event.type !== 'turn.completed' || event.reason !== 'cancelled' || event.message)
      return event
    const turn = this.turns.get(sessionId)
    if (turn?.stopRequested) return event
    const activity = this.activity.get(sessionId)
    if (activity?.stalled || activity?.declined) return event
    return {
      ...event,
      message:
        'The agent ended this turn on its own without finishing it (nobody pressed stop). Send a message to continue.',
    }
  }

  private touch(sessionId: string) {
    const activity = this.activity.get(sessionId)
    if (activity) activity.lastAt = now()
  }

  /** Keeps what the stall check needs: the last sign of life, running tools, open requests. */
  private observe(sessionId: string, event: SessionEvent) {
    const activity = this.activity.get(sessionId)
    if (!activity) return
    activity.lastAt = now()
    switch (event.type) {
      case 'tool.started':
        activity.tools.add(event.toolId)
        break
      case 'tool.completed':
        activity.tools.delete(event.toolId)
        break
      case 'approval.requested':
        activity.waiting.add(event.requestId)
        activity.denials.set(
          event.requestId,
          new Set(event.options.filter((o) => o.kind === 'deny').map((o) => o.id)),
        )
        break
      case 'question.requested':
        activity.waiting.add(event.requestId)
        break
      case 'approval.resolved':
        activity.waiting.delete(event.requestId)
        if (activity.denials.get(event.requestId)?.has(event.optionId)) activity.declined = true
        activity.denials.delete(event.requestId)
        break
      case 'question.resolved':
        activity.waiting.delete(event.requestId)
        break
      case 'turn.started':
        activity.stalled = false
        activity.declined = false
        break
      case 'turn.completed':
        activity.tools.clear()
        activity.waiting.clear()
        activity.denials.clear()
        activity.stalled = false
        activity.declined = false
        break
    }
  }

  /**
   * Stops turns whose agent went silent: no event for `stallMs` while no tool runs and nothing
   * waits for the user. Agents on stdio are known to hang mid-stream with the process alive, and
   * the session would otherwise show "running" forever.
   */
  private checkStalls() {
    if (this.unsaved.length > 0) this.saveUnsaved()
    const at = now()
    for (const [sessionId, activity] of this.activity) {
      const turn = this.turns.get(sessionId)
      if (!turn?.busy || activity.stalled) continue
      // Waiting for the user is never a stall: they may be away for hours.
      if (activity.waiting.size > 0) continue
      const inTool = activity.tools.size > 0
      const limit = inTool ? this.toolStallMs : this.stallMs
      if (limit <= 0 || at - activity.lastAt < limit) continue
      activity.stalled = true
      void this.stopStalled(sessionId, at - activity.lastAt, inTool)
    }
  }

  private async stopStalled(sessionId: string, silentMs: number, inTool = false) {
    const live = this.live.get(sessionId)
    if (!live) return
    const silence = describeDuration(silentMs)
    this.deps.log.warn(`${sessionId}: no word from the agent for ${silence}; stopping the turn`)
    try {
      this.deps.store.append({
        type: 'error',
        sessionId,
        at: Date.now(),
        message: inTool
          ? `A tool the agent started has run for ${silence} without any word from the agent, so the turn was stopped. Send a message to continue.`
          : `The agent sent nothing for ${silence}, so its turn was stopped. Send a message to continue.`,
      })
    } catch (err) {
      this.deps.log.error(`could not record the stall of ${sessionId}`, err)
    }
    // A hung agent may not answer the interrupt request either.
    await withTimeout(live.session.interrupt(), 10_000, 'interrupt').catch(() => undefined)
    // An agent that is truly hung does not answer the interrupt either: end its process, which
    // closes the turn (see endOrphanedTurn); the next message resumes the conversation.
    await new Promise((resolve) => setTimeout(resolve, 15_000).unref?.())
    if (this.live.get(sessionId) === live && this.turns.get(sessionId)?.busy) {
      this.closedOnPurpose.add(live.session)
      await withTimeout(live.session.close(), 5_000).catch(() => undefined)
    }
  }
}

/** Monotonic milliseconds: unaffected by the wall clock being set back or forward. */
function now(): number {
  return performance.now()
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function describeDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 2) return `${hours} hours`
  const minutes = Math.round(ms / 60_000)
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  return `${Math.round(ms / 1_000)} seconds`
}

/** Events that show a resumed agent really has its conversation. */
function confirmsConversation(event: SessionEvent): boolean {
  switch (event.type) {
    case 'message.delta':
      return event.role === 'assistant'
    case 'tool.started':
    case 'approval.requested':
    case 'question.requested':
    case 'plan.updated':
      return true
    case 'turn.completed':
      return event.reason === 'done'
    default:
      return false
  }
}

function lostConversationText(label: string, reason: string): string {
  return `${label} no longer has this conversation (${reason}), so it continues in a new one. The history above is kept here, but the agent does not remember it.`
}

const SIGN_IN =
  /invalid api key|not logged in|please run \/login|\/login\b|authentication[_ ]error|\b401\b|unauthori[sz]ed|(token|credentials?|login|session) (has )?expired|login required|not authenticated|sign in again|re-?authenticate/i
/** Agent events `record` keeps until the database takes them. */
const MUST_SAVE = new Set<string>([
  'session.provider-session',
  'turn.started',
  'turn.completed',
  'error',
  'approval.requested',
  'approval.resolved',
])

const LIMITED = /rate[ _-]?limit|\b429\b|too many requests|usage limit|quota|overloaded|\b529\b/i
const MISSING =
  /\bENOENT\b|command not found|is not recognized as an internal or external command|executable not found/i

/**
 * Adds what to do to an agent error that does not say: sign in again, wait for a rate limit, or
 * install the agent. These are the failures people hit most, and the raw text rarely helps.
 */
export function withHint(message: string): string {
  if (SIGN_IN.test(message) && !/sign in on the host/i.test(message))
    return `${message}\n\nThe agent needs you to sign in again: sign in to it on the host computer (for example run \`claude\` and then /login, or \`codex login\`), then send your message again.`
  if (LIMITED.test(message) && !/(reset|try again|retry|wait)/i.test(message))
    return `${message}\n\nThe agent's provider is busy or limiting requests right now. Wait a little, then send your message again.`
  if (MISSING.test(message) && !/install/i.test(message))
    return `${message}\n\nThe agent's program could not be found on the host computer. Check that it is installed and on the host's PATH, then send your message again.`
  return message
}

/** The agent could not find the conversation it was asked to resume. */
function isLostConversation(err: unknown): boolean {
  return /no conversation found|no rollout found|session not found|unknown session|could not find session|failed to resume/i.test(
    errorText(err),
  )
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
