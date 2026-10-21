import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { SessionEvent } from '@beddcode/contracts'
import { diffText } from '@beddcode/shared'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never
type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'other'

const MAX_OUTPUT = 4_000

export function toolKind(kind: string | null | undefined): ToolKind {
  switch (kind) {
    case 'execute':
      return 'command'
    case 'read':
      return 'read'
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit'
    case 'search':
    case 'fetch':
      return 'search'
    default:
      return 'other'
  }
}

interface ToolState {
  title: string
  done: boolean
  /** Latest diff per path, emitted once the tool succeeds. */
  diffs: Map<string, { path: string; oldText?: string | null; newText: string }>
  output?: string
}

function textOf(content: ToolCallContent[] | null | undefined): string | undefined {
  const text = (content ?? [])
    .flatMap((c) => (c.type === 'content' && c.content.type === 'text' ? [c.content.text] : []))
    .join('\n')
  return text ? text.slice(0, MAX_OUTPUT) : undefined
}

function rawOutputText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return text ? text.slice(0, MAX_OUTPUT) : undefined
}

/**
 * Converts ACP `session/update` notifications into the shared event vocabulary. Edits arrive as
 * diff content on a tool call; the diff is emitted when the call completes successfully.
 */
export class AcpEventMapper {
  private turnId: string | undefined
  private modes: { id: string; label: string; description?: string }[] = []
  private readonly tools = new Map<string, ToolState>()

  constructor(
    private readonly sessionId: string,
    private readonly now: () => number = Date.now,
  ) {}

  setTurn(turnId: string | undefined) {
    this.turnId = turnId
  }

  setModes(modes: { id: string; label: string; description?: string }[]) {
    this.modes = modes
  }

  map(update: SessionUpdate): SessionEvent[] {
    const out: Draft[] = []

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text' && update.content.text) {
          out.push({ type: 'message.delta', role: 'assistant', text: update.content.text })
        }
        break

      case 'tool_call': {
        const state = this.track(update.toolCallId, update.title, update.content, out, update.kind)
        this.collectDiffs(state, update.content)
        state.output = textOf(update.content) ?? rawOutputText(update.rawOutput) ?? state.output
        if (update.status === 'completed' || update.status === 'failed') {
          this.finish(update.toolCallId, state, update.status === 'completed', out)
        }
        break
      }

      case 'tool_call_update': {
        const state = this.track(
          update.toolCallId,
          update.title ?? undefined,
          update.content,
          out,
          update.kind,
        )
        this.collectDiffs(state, update.content)
        state.output = textOf(update.content) ?? rawOutputText(update.rawOutput) ?? state.output
        if (update.status === 'completed' || update.status === 'failed') {
          this.finish(update.toolCallId, state, update.status === 'completed', out)
        }
        break
      }

      case 'current_mode_update':
        out.push({
          type: 'session.modes',
          modes: this.modes,
          currentModeId: update.currentModeId,
        })
        break
    }

    return out.map(
      (e) =>
        ({ ...e, sessionId: this.sessionId, turnId: this.turnId, at: this.now() }) as SessionEvent,
    )
  }

  /** Registers a tool the first time it is seen, announcing it to the UI. */
  private track(
    id: string,
    title: string | undefined,
    _content: ToolCallContent[] | null | undefined,
    out: Draft[],
    kind: string | null | undefined,
  ): ToolState {
    let state = this.tools.get(id)
    if (!state) {
      state = { title: title ?? id, done: false, diffs: new Map() }
      this.tools.set(id, state)
      out.push({
        type: 'tool.started',
        toolId: id,
        kind: toolKind(kind),
        title: state.title,
      })
    }
    return state
  }

  private collectDiffs(state: ToolState, content: ToolCallContent[] | null | undefined) {
    for (const c of content ?? []) {
      if (c.type !== 'diff') continue
      // Some agents spell one file two ways (`C:/a/b\file` and `C:\a\b\file`); count it once.
      const key = c.path.replace(/\\/g, '/')
      state.diffs.set(key, { path: c.path, oldText: c.oldText, newText: c.newText })
    }
  }

  private finish(id: string, state: ToolState, ok: boolean, out: Draft[]) {
    if (state.done) return
    state.done = true
    out.push({ type: 'tool.completed', toolId: id, ok, output: state.output })
    if (ok) {
      for (const d of state.diffs.values()) {
        out.push({ type: 'diff', path: d.path, ...diffText(d.oldText, d.newText) })
      }
    }
  }
}
