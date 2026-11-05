import type {
  ConfigOption,
  PlanStep,
  QuestionSpec,
  SlashCommand,
  StoredEvent,
  TurnChangedFile,
  SessionSegment,
} from '@beddcode/contracts'
import { projectSegmentEvent } from '@beddcode/contracts'
import { sessionChanges } from './blocks.ts'

export type SessionStatus = 'idle' | 'running' | 'needs-you' | 'failed'

export type TranscriptItem =
  | {
      kind: 'agent-message'
      id: string
      threadId: string
      messageId?: string
      senderId: string
      recipientId: string
      text: string
    }
  | {
      kind: 'message'
      id: string
      role: 'user' | 'assistant'
      text: string
      turnId?: string
      /** For the agent's replies: which turn of the session it belongs to (1-based). */
      turnNo?: number
      attachments?: { name: string; path: string }[]
    }
  | {
      kind: 'tool'
      id: string
      title: string
      toolKind: 'command' | 'read' | 'edit' | 'search' | 'other'
      status: 'running' | 'ok' | 'failed' | 'cancelled'
      output?: string
      /** The arguments it was called with (pretty JSON), when the agent says. */
      input?: string
      /** Files it touches, in full, when the agent says. */
      paths?: string[]
      at?: number
      /** When the tool began and ended (epoch ms), for durations. */
      startedAt?: number
      endedAt?: number
      /** The user's say on it, when the agent asked first (see `approval.requested`'s toolId). */
      approval?: {
        requestId: string
        requestedAt: number
        resolvedAt?: number
        /** allow / deny as the chosen option is classed; cancelled when the turn ended first. */
        outcome?: 'allow' | 'deny' | 'other' | 'cancelled'
      }
      /**
       * Whether the agent asked before running it, as the provider reports when the tool ends.
       * False means the agent's own policy let it run without a prompt.
       */
      asked?: boolean
    }
  | { kind: 'diff'; id: string; path: string; added: number; removed: number; patch: string }
  | {
      kind: 'approval'
      id: string
      requestId: string
      /** The tool call this is about, when the provider says. */
      toolId?: string
      title: string
      detail?: string
      /** A plan to approve (markdown), when the agent asks to leave plan mode. */
      plan?: string
      options: { id: string; label: string; kind: 'allow' | 'deny' | 'other' }[]
      resolvedOptionId?: string
      cancelled?: boolean
    }
  | {
      kind: 'question'
      id: string
      requestId: string
      questions: QuestionSpec[]
      /** What was chosen or typed, by question id. */
      answers?: Record<string, string[]>
      /** Closed without an answer (dismissed, or the turn ended). */
      dismissed?: boolean
    }
  | {
      /** What a finished turn changed in the folder (from host snapshots), undoable if latest. */
      kind: 'changes'
      id: string
      turnId?: string
      before: string
      after: string
      files: TurnChangedFile[]
      truncated?: boolean
      coverage?: { state: 'full' | 'skipped' | 'truncated' | 'expired'; reason?: string }
      /** The user undid these changes. */
      reverted?: boolean
    }
  | {
      kind: 'compaction'
      id: string
      state: 'running' | 'done' | 'failed'
      trigger?: 'manual' | 'auto'
      tokensBefore?: number
      tokensAfter?: number
    }
  | {
      kind: 'notice'
      id: string
      message: string
      hostUpdating?: true
      transient?: boolean
      key?: string
    }
  | {
      kind: 'switch'
      id: string
      from: string
      to: string
      handoff: string
      permissionLabel?: string
      permissionNote?: string
    }
  | { kind: 'error'; id: string; message: string }

export type BoardStage = 'pending' | 'in-progress' | 'review' | 'done'

export interface SessionView {
  /** Provider history, reconstructed from the durable event log. */
  segments?: SessionSegment[]
  boardStage?: BoardStage
  notes?: { text: string; version: number }
  id: string
  title: string
  cwd: string
  instanceId: string
  /** What the session was started with (model alias, effort), when the user chose one. */
  model?: string
  effort?: string
  /** Repository (or folder) this session belongs to; equals `cwd` unless it runs in a worktree. */
  projectPath: string
  /** The working directory is managed by the host, without a selected project. */
  projectless?: boolean
  branch?: string
  /** Present when the session runs in a worktree made for it. */
  worktree?: { baseBranch: string; copiedFiles?: number }
  createdAt: number
  updatedAt: number
  /** In the sidebar's Done section, by the user's choice; a new turn takes it out again. */
  done?: boolean
  /** Pinned to the top of the sidebar by the user. */
  pinned?: boolean
  /** Marked by the user as waiting on them; a message from the user clears it. */
  waitingMark?: { note?: string; remindAt?: number; since: number }
  status: SessionStatus
  /** When `status` last changed; the running / waiting timers count from here. */
  statusSince: number
  /** How long the last finished turn ran, in ms. */
  lastTurnMs?: number
  /** How long each finished turn ran, in ms, by turn number. */
  turnDurations?: Record<number, number>
  /** When the running turn began. */
  turnStartedAt?: number
  lastTurnReason?: 'done' | 'cancelled' | 'error'
  /** Why the last turn ended, when it was not the agent finishing (stopped, crashed, host restart). */
  lastTurnMessage?: string
  /**
   * The user turned down a request in the turn that is running (or just ended). Some agents (Grok)
   * end the turn right after a "no", which then reads as cancelled although nobody pressed Stop.
   */
  declined?: boolean
  items: TranscriptItem[]
  added: number
  removed: number
  /** Turns started and finished so far; a fork can end after any finished turn. */
  turns: number
  completedTurns: number
  /** Messages typed while the agent was busy, in the order they will be sent. */
  queue: { queueId: string; text: string; attachments: { name: string; path: string }[] }[]
  /** The agent's own plan or to-do list, as of its latest update. */
  plan?: { steps: PlanStep[]; explanation?: string }
  /** Slash commands and skills the agent offers right now. */
  commands: SlashCommand[]
  /** Started by another session through its agent tools. */
  parent?: { sessionId: string; depth: number; requestId?: string }
  orchestrationPlans?: {
    planId: string
    goal: string
    tasks: { id: string; agent: string; prompt: string; worktree: boolean }[]
  }[]
  /** Started by a schedule. */
  schedule?: { id: string; name: string }
  mcpGateway?: boolean
  telegram?: boolean
  /** Can start and manage other sessions. */
  agentTools?: boolean
  /** The agent may use the desktop app's browser pane. */
  browserTools?: boolean
  /** The agent may draw on the host's design canvases. */
  designTools?: boolean
  /** The agent may operate the host's desktop. */
  computerTools?: boolean
  /** The agent may read the user's Linear issues. */
  linearTools?: boolean
  /** How long the agent took to become ready, and whether a warm process was used. */
  start?: { warm: boolean; ms: number }
  /** The agent's own per-session settings (model, thinking level, ...). */
  config: ConfigOption[]
  /** The session this one continues, when it was forked. */
  forkedFrom?: { sessionId: string; title?: string }
  handoffFrom?: { sessionId: string; title?: string }
  handoffsTo?: { sessionId: string; agent: string; reason?: string; at: number }[]
  sideThread?: boolean
  /** Started outside BeddCode and brought in. */
  imported?: boolean
  /** Modes reported by the agent for this session, when it reports any. */
  /** How much of the agent's context window is in use, when the agent says. */
  context?: { used: number; size: number }
  /** How a session another agent started said its task ended (its report_result), this task. */
  result?: { status: 'done' | 'blocked' | 'failed' | 'stopped'; summary: string }
  /** Everything the agent has used so far, as it reports it: all tokens, and cost when it says. */
  usage?: { tokens: number; costUsd: number }
  modes?: { id: string; label: string; description?: string; dangerous?: boolean }[]
  currentModeId?: string
}

/** Everything the UI shows is a pure projection of the host's event log. */
export interface ReplicaState {
  lastSeq: number
  /** Session ids, newest first. */
  order: string[]
  sessions: Record<string, SessionView>
}

export const emptyReplica = (): ReplicaState => ({ lastSeq: 0, order: [], sessions: {} })

/** Fold a received burst, copying a streaming message's history only once per contiguous run. */
/**
 * Where a turn's changes card goes: after the turn's last item, which is before any message of a
 * later turn that was sent while the snapshot was being taken. At the end when nothing follows.
 */
function changesPlace(items: TranscriptItem[], turnId: string | undefined): number {
  if (turnId === undefined) return items.length
  const last = items.findLastIndex((item) => item.kind === 'message' && item.turnId === turnId)
  if (last < 0) return items.length
  const later = items.findIndex(
    (item, i) =>
      i > last && item.kind === 'message' && item.role === 'user' && item.turnId !== turnId,
  )
  return later < 0 ? items.length : later
}

export function applyEvents(state: ReplicaState, events: readonly StoredEvent[]): ReplicaState {
  let next = state
  for (let i = 0; i < events.length; i++) {
    const stored = events[i]!
    if (stored.seq <= next.lastSeq) continue
    const e = stored.event
    if (e.type !== 'message.delta' || e.role !== 'assistant') {
      next = applyEvent(next, stored)
      continue
    }
    const parts = [e.text]
    let last = stored
    while (i + 1 < events.length) {
      const following = events[i + 1]!
      const f = following.event
      if (following.seq <= last.seq) break
      if (
        f.type !== 'message.delta' ||
        f.role !== 'assistant' ||
        f.sessionId !== e.sessionId ||
        f.turnId !== e.turnId
      )
        break
      parts.push(f.text)
      last = following
      i++
    }
    // Keep the first sequence as the message id; the last is the reconnect cursor.
    next = applyEvent(next, {
      seq: stored.seq,
      event: { ...e, text: parts.join(''), at: last.event.at },
    })
    if (last !== stored) next = { ...next, lastSeq: last.seq }
  }
  return next
}

/** Is anything open that the agent is waiting on the user for? */
function waiting(items: TranscriptItem[]): boolean {
  return items.some(
    (item) =>
      (item.kind === 'approval' && !item.resolvedOptionId && !item.cancelled) ||
      (item.kind === 'question' && !item.answers && !item.dismissed),
  )
}

/** Real output (or the end of the turn) makes "still waiting" style notices obsolete. */
function endsWaiting(e: StoredEvent['event']): boolean {
  switch (e.type) {
    case 'message.delta':
      return e.role === 'assistant'
    case 'tool.started':
    case 'approval.requested':
    case 'question.requested':
    case 'turn.started':
    case 'turn.completed':
    case 'error':
      return true
    default:
      return false
  }
}

export function applyEvent(state: ReplicaState, stored: StoredEvent): ReplicaState {
  // Reconnects can replay what we already hold; the log is idempotent by seq.
  if (stored.seq <= state.lastSeq) return state
  const e = stored.event

  if (e.type === 'session.created') {
    const view: SessionView = {
      id: e.sessionId,
      title: e.title,
      cwd: e.cwd,
      instanceId: e.instanceId,
      segments: projectSegmentEvent([], e),
      model: e.model,
      effort: e.effort,
      projectPath: e.projectPath ?? e.cwd,
      projectless: e.projectless,
      branch: e.branch,
      worktree: e.worktree,
      createdAt: e.at,
      updatedAt: e.at,
      status: 'idle',
      statusSince: e.at,
      items: [],
      added: 0,
      removed: 0,
      turns: 0,
      completedTurns: 0,
      queue: [],
      commands: [],
      config: [],
      forkedFrom: e.forkedFrom,
      handoffFrom: e.handoffFrom,
      sideThread: e.sideThread,
      imported: e.imported,
      parent: e.parent,
      schedule: e.schedule,
      mcpGateway: e.mcpGateway,
      telegram: e.telegram,
      agentTools: e.agentTools,
      browserTools: e.browserTools,
      designTools: e.designTools,
      computerTools: e.computerTools,
      linearTools: e.linearTools,
      start: e.start,
    }
    return {
      lastSeq: stored.seq,
      order: [e.sessionId, ...state.order.filter((id) => id !== e.sessionId)],
      sessions: { ...state.sessions, [e.sessionId]: view },
    }
  }

  if (e.type === 'session.deleted') {
    const { [e.sessionId]: _gone, ...sessions } = state.sessions
    return {
      lastSeq: stored.seq,
      order: state.order.filter((id) => id !== e.sessionId),
      sessions,
    }
  }

  const held = state.sessions[e.sessionId]
  if (!held) return { ...state, lastSeq: stored.seq }
  // "Host is updating" only holds until the host is back: once the interrupted turn resumes
  // (or ends), the notice is stale and would contradict the "Caught up" indicator.
  const resumed =
    e.type === 'turn.started' ||
    e.type === 'turn.completed' ||
    e.type === 'error' ||
    (e.type === 'message.delta' && e.role === 'user')
  const current =
    resumed && held.items.some((item) => item.kind === 'notice' && item.hostUpdating)
      ? {
          ...held,
          items: held.items.filter((item) => !(item.kind === 'notice' && item.hostUpdating)),
        }
      : held

  let next: SessionView = { ...current, updatedAt: e.at }
  const id = `${stored.seq}`
  // The agent carried on after a "no", so if the turn stops now it is the user's doing.
  if (
    current.declined &&
    (e.type === 'tool.started' ||
      e.type === 'approval.requested' ||
      (e.type === 'message.delta' && e.role === 'assistant'))
  )
    next.declined = undefined
  switch (e.type) {
    case 'orchestration.plan':
      next.orchestrationPlans = [
        ...(current.orchestrationPlans ?? []).filter((p) => p.planId !== e.planId),
        { planId: e.planId, goal: e.goal, tasks: e.tasks },
      ]
      break
    case 'session.renamed':
      next.title = e.title
      break
    case 'session.notes':
      next.notes = { text: e.text, version: e.version }
      next.updatedAt = current.updatedAt
      break
    case 'session.board-stage':
      next.boardStage = e.stage
      next.updatedAt = current.updatedAt
      break
    case 'session.done':
      next.done = e.done || undefined
      // Filing a session away is not activity: it keeps its place in time.
      next.updatedAt = current.updatedAt
      break
    case 'session.pinned':
      next.pinned = e.pinned || undefined
      next.updatedAt = current.updatedAt
      break
    case 'session.waiting':
      next.waitingMark = e.waiting
        ? { note: e.note || undefined, remindAt: e.remindAt, since: e.at }
        : undefined
      if (e.waiting) next.done = undefined
      next.updatedAt = current.updatedAt
      break
    case 'turn.changes': {
      const card: TranscriptItem = {
        kind: 'changes',
        id,
        turnId: e.turnId,
        before: e.before,
        after: e.after,
        files: e.files,
        truncated: e.truncated,
        coverage: e.coverage,
      }
      // The snapshot is taken after the turn ends and can land after a queued message has already
      // started the next turn. The card belongs to the turn it describes: before that message.
      const at = changesPlace(current.items, e.turnId)
      next.items = [...current.items.slice(0, at), card, ...current.items.slice(at)]
      next.updatedAt = current.updatedAt
      // The host's snapshot is the full picture of the turn, commands included.
      Object.assign(next, sessionChanges(next.items))
      break
    }
    case 'turn.reverted':
      next.items = current.items.map((item) =>
        item.kind === 'changes' && item.after === e.after ? { ...item, reverted: true } : item,
      )
      Object.assign(next, sessionChanges(next.items))
      break
    case 'session.model':
      next.model = e.model
      next.effort = e.effort
      next.segments = projectSegmentEvent(current.segments ?? [], e)
      break
    case 'session.context':
      next.context = { used: e.used, size: e.size }
      break
    case 'session.compaction': {
      const running = current.items.findLastIndex(
        (item) => item.kind === 'compaction' && item.state === 'running',
      )
      const state = e.state === 'started' ? 'running' : e.state === 'finished' ? 'done' : 'failed'
      const item: Extract<TranscriptItem, { kind: 'compaction' }> = {
        kind: 'compaction',
        id: running >= 0 ? current.items[running]!.id : id,
        state,
        trigger: e.trigger,
        tokensBefore: e.tokensBefore,
        tokensAfter: e.tokensAfter,
      }
      next.items =
        running >= 0
          ? current.items.map((it, i) =>
              i === running ? { ...item, trigger: e.trigger ?? (it as typeof item).trigger } : it,
            )
          : [...current.items, item]
      break
    }
    case 'session.result':
      next.result = { status: e.status, summary: e.summary }
      break
    case 'agent.message':
      next.items = [
        ...current.items,
        {
          kind: 'agent-message',
          id,
          threadId: e.threadId,
          messageId: e.messageId,
          senderId: e.senderId,
          recipientId: e.recipientId,
          text: e.text,
        },
      ]
      break
    case 'session.usage':
      if (!current.model && e.model) next.model = e.model
      next.usage = {
        tokens:
          (current.usage?.tokens ?? 0) +
          e.inputTokens +
          e.outputTokens +
          (e.cacheReadTokens ?? 0) +
          (e.cacheWriteTokens ?? 0),
        costUsd: (current.usage?.costUsd ?? 0) + (e.costUsd ?? 0),
      }
      break
    case 'session.provider-session':
      next.updatedAt = current.updatedAt
      next.segments = projectSegmentEvent(current.segments ?? [], e)
      break
    case 'session.switched': {
      const segments = current.segments ?? [
        { provider: current.instanceId, model: current.model, startedAt: current.createdAt },
      ]
      next.segments = projectSegmentEvent(segments, e)
      next.items = [
        ...current.items,
        {
          kind: 'switch',
          id,
          from: current.instanceId,
          to: e.instanceId,
          handoff: e.handoff,
          permissionLabel: e.permissionLabel,
          permissionNote: e.permissionNote,
        },
      ]
      next.instanceId = e.instanceId
      next.model = e.model
      next.effort = e.effort
      // Options, modes and commands belong to the agent that offered them; the new one announces
      // its own, and until then the composer must not show the old agent's.
      next.config = []
      next.modes = []
      // The mode carried over is shown until the new agent announces its own list.
      next.currentModeId = e.permissionMode
      next.commands = []
      break
    }
    case 'session.notice':
      next.items = [
        ...current.items.filter(
          (item) => !(item.kind === 'notice' && e.key !== undefined && item.key === e.key),
        ),
        { kind: 'notice', id, message: e.message, transient: e.transient, key: e.key },
      ]
      break
    case 'host.updating':
      next.items = [
        ...current.items,
        { kind: 'notice', id, message: e.message, hostUpdating: true },
      ]
      break
    case 'session.modes':
      next.modes = e.modes
      next.currentModeId = e.currentModeId
      break
    case 'turn.started':
      next.waitingMark = undefined
      next.result = undefined
      next.done = undefined
      next.turns = current.turns + 1
      next.status = 'running'
      next.turnStartedAt = e.at
      next.lastTurnReason = undefined
      next.lastTurnMessage = undefined
      next.declined = undefined
      break
    case 'message.delta': {
      if (e.role === 'user') next.waitingMark = undefined
      if (
        e.role === 'user' &&
        current.title ===
          (current.projectless
            ? 'New session'
            : `Session in ${current.projectPath.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? current.projectPath}`) &&
        !current.items.some((item) => item.kind === 'message' && item.role === 'user')
      ) {
        const title = e.text.trim().replace(/\s+/g, ' ')
        if (title) next.title = title.length > 76 ? `${title.slice(0, 75).trimEnd()}…` : title
      }
      const last = current.items.at(-1)
      if (
        e.role === 'assistant' &&
        last?.kind === 'message' &&
        last.role === 'assistant' &&
        last.turnId === e.turnId
      ) {
        next.items = [...current.items.slice(0, -1), { ...last, text: last.text + e.text }]
      } else {
        next.items = [
          ...current.items,
          {
            kind: 'message',
            id,
            role: e.role,
            text: e.text,
            turnId: e.turnId,
            turnNo: e.role === 'assistant' ? current.turns : undefined,
            attachments: e.attachments,
          },
        ]
      }
      break
    }
    case 'tool.started':
      next.items = [
        ...current.items,
        {
          kind: 'tool',
          id: e.toolId,
          title: e.title,
          toolKind: e.kind,
          status: 'running',
          at: e.at,
          startedAt: e.at,
          ...(e.input !== undefined ? { input: e.input } : {}),
          ...(e.paths !== undefined ? { paths: e.paths } : {}),
        },
      ]
      break
    case 'tool.updated':
      next.items = current.items.map((item) =>
        item.kind === 'tool' && item.id === e.toolId
          ? {
              ...item,
              title: e.title ?? item.title,
              toolKind: e.kind ?? item.toolKind,
              ...(e.input !== undefined ? { input: e.input } : {}),
              ...(e.paths !== undefined ? { paths: e.paths } : {}),
            }
          : item,
      )
      break
    case 'tool.completed':
      next.items = current.items.map((item) =>
        item.kind === 'tool' && item.id === e.toolId
          ? {
              ...item,
              status: e.ok ? 'ok' : 'failed',
              output: e.output,
              at: e.at,
              endedAt: e.at,
              asked: e.approval === undefined ? item.asked : e.approval === 'asked',
            }
          : item,
      )
      break
    case 'diff':
      next.items = [
        ...current.items,
        { kind: 'diff', id, path: e.path, added: e.added, removed: e.removed, patch: e.patch },
      ]
      next.added += e.added
      next.removed += e.removed
      break
    case 'approval.requested':
      next.items = [
        ...current.items,
        {
          kind: 'approval',
          id,
          requestId: e.requestId,
          toolId: e.toolId,
          title: e.title,
          detail: e.detail,
          plan: e.plan,
          options: e.options,
        },
      ]
      if (e.toolId) {
        next.items = next.items.map((item) =>
          item.kind === 'tool' && item.id === e.toolId && item.status === 'running'
            ? { ...item, approval: { requestId: e.requestId, requestedAt: e.at } }
            : item,
        )
      }
      next.status = 'needs-you'
      break
    case 'question.requested':
      next.items = [
        ...current.items,
        { kind: 'question', id, requestId: e.requestId, questions: e.questions },
      ]
      next.status = 'needs-you'
      break
    case 'question.resolved':
      next.items = current.items.map((item) =>
        item.kind === 'question' && item.requestId === e.requestId
          ? { ...item, answers: e.answers, dismissed: e.answers === undefined }
          : item,
      )
      next.status = waiting(next.items)
        ? 'needs-you'
        : current.status === 'needs-you'
          ? // A request the host made after the turn ended (a push approval) leaves it idle, not running.
            current.lastTurnReason !== undefined
            ? 'idle'
            : 'running'
          : current.status
      break
    case 'prompt.queued':
      next.queue = [
        ...current.queue,
        { queueId: e.queueId, text: e.text, attachments: e.attachments ?? [] },
      ]
      break
    case 'prompt.dequeued':
      next.queue = current.queue.filter((q) => q.queueId !== e.queueId)
      break
    case 'prompt.edited':
      next.queue = current.queue.map((q) => (q.queueId === e.queueId ? { ...q, text: e.text } : q))
      break
    case 'prompt.reordered': {
      const rank = new Map(e.queueIds.map((id, i) => [id, i]))
      next.queue = [...current.queue].sort(
        (a, b) => (rank.get(a.queueId) ?? Infinity) - (rank.get(b.queueId) ?? Infinity),
      )
      break
    }
    case 'plan.updated':
      next.plan = { steps: e.steps, explanation: e.explanation }
      break
    case 'session.commands':
      next.commands = e.commands
      break
    case 'session.config': {
      next.config = e.options
      const chosen = e.options.find((option) => option.category === 'model')?.value
      if (typeof chosen === 'string' && chosen) next.model = chosen
      next.segments = projectSegmentEvent(current.segments ?? [], e)
      break
    }
    case 'approval.resolved': {
      const request = current.items.find(
        (item) => item.kind === 'approval' && item.requestId === e.requestId,
      )
      const outcome =
        request?.kind === 'approval'
          ? (request.options.find((o) => o.id === e.optionId)?.kind ??
            (e.optionId === 'cancelled' ? 'cancelled' : undefined))
          : undefined
      next.items = current.items.map((item) =>
        item.kind === 'approval' && item.requestId === e.requestId
          ? { ...item, resolvedOptionId: e.optionId }
          : item.kind === 'tool' && item.approval?.requestId === e.requestId
            ? { ...item, approval: { ...item.approval, resolvedAt: e.at, outcome } }
            : item,
      )
      if (outcome === 'deny') next.declined = true
      next.status = waiting(next.items)
        ? 'needs-you'
        : current.status === 'needs-you'
          ? // A request the host made after the turn ended (a push approval) leaves it idle, not running.
            current.lastTurnReason !== undefined
            ? 'idle'
            : 'running'
          : current.status
      break
    }
    case 'session.handed-off':
      next.handoffsTo = [
        ...(current.handoffsTo ?? []),
        { sessionId: e.targetSessionId, agent: e.agent, reason: e.reason, at: e.at },
      ]
      break
    case 'turn.completed':
      next.completedTurns = current.completedTurns + 1
      if (current.turnStartedAt !== undefined) {
        next.lastTurnMs = e.at - current.turnStartedAt
        next.turnDurations = { ...current.turnDurations, [current.turns]: next.lastTurnMs }
      }
      next.turnStartedAt = undefined
      next.status = e.reason === 'error' ? 'failed' : 'idle'
      next.lastTurnReason = e.reason
      next.lastTurnMessage = e.message
      next.items = current.items.map((item) => {
        if (item.kind === 'approval' && !item.resolvedOptionId) return { ...item, cancelled: true }
        if (item.kind === 'question' && !item.answers && !item.dismissed)
          return { ...item, dismissed: true }
        if (item.kind === 'compaction' && item.state === 'running')
          return { ...item, state: e.reason === 'done' ? 'done' : 'failed' }
        if (item.kind === 'tool' && item.status === 'running' && e.reason !== 'done')
          return {
            ...item,
            status: e.reason === 'cancelled' ? 'cancelled' : 'failed',
            endedAt: item.endedAt ?? e.at,
          }
        return item
      })
      if (e.message) next.items = [...next.items, { kind: 'notice', id, message: e.message }]
      break
    case 'error':
      next.items = [...current.items, { kind: 'error', id, message: e.message }]
      next.status = 'failed'
      break
  }

  if (next.status !== current.status) next.statusSince = e.at
  if (endsWaiting(e) && next.items.some((item) => item.kind === 'notice' && item.transient))
    next.items = next.items.filter((item) => !(item.kind === 'notice' && item.transient))
  next = { ...next }
  return { ...state, lastSeq: stored.seq, sessions: { ...state.sessions, [e.sessionId]: next } }
}
