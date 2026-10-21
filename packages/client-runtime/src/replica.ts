import type { StoredEvent } from '@beddcode/contracts'

export type SessionStatus = 'idle' | 'running' | 'needs-you' | 'failed'

export type TranscriptItem =
  | {
      kind: 'message'
      id: string
      role: 'user' | 'assistant'
      text: string
      turnId?: string
      attachments?: { name: string; path: string }[]
    }
  | {
      kind: 'tool'
      id: string
      title: string
      toolKind: 'command' | 'read' | 'edit' | 'search' | 'other'
      status: 'running' | 'ok' | 'failed'
      output?: string
    }
  | { kind: 'diff'; id: string; path: string; added: number; removed: number; patch: string }
  | {
      kind: 'approval'
      id: string
      requestId: string
      title: string
      detail?: string
      options: { id: string; label: string; kind: 'allow' | 'deny' | 'other' }[]
      resolvedOptionId?: string
    }
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
  items: TranscriptItem[]
  added: number
  removed: number
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
    case 'session.provider-session':
      return { ...state, lastSeq: stored.seq }
    case 'session.modes':
      next.modes = e.modes
      next.currentModeId = e.currentModeId
      break
    case 'turn.started':
      next.status = 'running'
      break
    case 'message.delta': {
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
            attachments: e.attachments,
          },
        ]
      }
      break
    }
    case 'tool.started':
      next.items = [
        ...current.items,
        { kind: 'tool', id: e.toolId, title: e.title, toolKind: e.kind, status: 'running' },
      ]
      break
    case 'tool.completed':
      next.items = current.items.map((item) =>
        item.kind === 'tool' && item.id === e.toolId
          ? { ...item, status: e.ok ? 'ok' : 'failed', output: e.output }
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
          title: e.title,
          detail: e.detail,
          options: e.options,
        },
      ]
      next.status = 'needs-you'
      break
    case 'approval.resolved':
      next.items = current.items.map((item) =>
        item.kind === 'approval' && item.requestId === e.requestId
          ? { ...item, resolvedOptionId: e.optionId }
          : item,
      )
      next.status = 'running'
      break
    case 'turn.completed':
      next.status = e.reason === 'error' ? 'failed' : 'idle'
      break
    case 'error':
      next.items = [...current.items, { kind: 'error', id, message: e.message }]
      next.status = 'failed'
      break
  }

  next = { ...next }
  return { ...state, lastSeq: stored.seq, sessions: { ...state.sessions, [e.sessionId]: next } }
}
