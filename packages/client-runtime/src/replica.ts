import type {
  ConfigOption,
  PlanStep,
  QuestionSpec,
  SlashCommand,
  StoredEvent,
} from '@beddcode/contracts'

export type SessionStatus = 'idle' | 'running' | 'needs-you' | 'failed'

export type TranscriptItem =
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
  | { kind: 'notice'; id: string; message: string }
  | { kind: 'error'; id: string; message: string }

export interface SessionView {
  id: string
  title: string
  cwd: string
  instanceId: string
  /** What the session was started with (model alias, effort), when the user chose one. */
  model?: string
  effort?: string
  /** Repository (or folder) this session belongs to; equals `cwd` unless it runs in a worktree. */
  projectPath: string
  branch?: string
  /** Present when the session runs in a worktree made for it. */
  worktree?: { baseBranch: string }
  createdAt: number
  updatedAt: number
  status: SessionStatus
  lastTurnReason?: 'done' | 'cancelled' | 'error'
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
  /** The agent's own per-session settings (model, thinking level, ...). */
  config: ConfigOption[]
  /** The session this one continues, when it was forked. */
  forkedFrom?: { sessionId: string; title?: string }
  /** Started outside BeddCode and brought in. */
  imported?: boolean
  /** Modes reported by the agent for this session, when it reports any. */
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

/** Is anything open that the agent is waiting on the user for? */
function waiting(items: TranscriptItem[]): boolean {
  return items.some(
    (item) =>
      (item.kind === 'approval' && !item.resolvedOptionId && !item.cancelled) ||
      (item.kind === 'question' && !item.answers && !item.dismissed),
  )
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
      model: e.model,
      effort: e.effort,
      projectPath: e.projectPath ?? e.cwd,
      branch: e.branch,
      worktree: e.worktree,
      createdAt: e.at,
      updatedAt: e.at,
      status: 'idle',
      items: [],
      added: 0,
      removed: 0,
      turns: 0,
      completedTurns: 0,
      queue: [],
      commands: [],
      config: [],
      forkedFrom: e.forkedFrom,
      imported: e.imported,
    }
    return {
      lastSeq: stored.seq,
      order: [e.sessionId, ...state.order.filter((id) => id !== e.sessionId)],
      sessions: { ...state.sessions, [e.sessionId]: view },
    }
  }

  const current = state.sessions[e.sessionId]
  if (!current) return { ...state, lastSeq: stored.seq }

  let next: SessionView = { ...current, updatedAt: e.at }
  const id = `${stored.seq}`

  switch (e.type) {
    case 'session.renamed':
      next.title = e.title
      break
    case 'session.model':
      next.model = e.model
      next.effort = e.effort
      break
    case 'session.provider-session':
      return { ...state, lastSeq: stored.seq }
    case 'session.modes':
      next.modes = e.modes
      next.currentModeId = e.currentModeId
      break
    case 'turn.started':
      next.turns = current.turns + 1
      next.status = 'running'
      next.lastTurnReason = undefined
      break
    case 'message.delta': {
      if (
        e.role === 'user' &&
        current.title ===
          `Session in ${current.projectPath.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? current.projectPath}` &&
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
        },
      ]
      break
    case 'tool.updated':
      next.items = current.items.map((item) =>
        item.kind === 'tool' && item.id === e.toolId
          ? { ...item, title: e.title ?? item.title, toolKind: e.kind ?? item.toolKind }
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
          ? 'running'
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
    case 'plan.updated':
      next.plan = { steps: e.steps, explanation: e.explanation }
      break
    case 'session.commands':
      next.commands = e.commands
      break
    case 'session.config':
      next.config = e.options
      break
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
      next.status = waiting(next.items)
        ? 'needs-you'
        : current.status === 'needs-you'
          ? 'running'
          : current.status
      break
    }
    case 'turn.completed':
      next.completedTurns = current.completedTurns + 1
      next.status = e.reason === 'error' ? 'failed' : 'idle'
      next.lastTurnReason = e.reason
      next.items = current.items.map((item) => {
        if (item.kind === 'approval' && !item.resolvedOptionId) return { ...item, cancelled: true }
        if (item.kind === 'question' && !item.answers && !item.dismissed)
          return { ...item, dismissed: true }
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

  next = { ...next }
  return { ...state, lastSeq: stored.seq, sessions: { ...state.sessions, [e.sessionId]: next } }
}
