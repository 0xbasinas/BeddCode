import type { SessionConfigOption, SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { ConfigOption, SessionEvent } from '@beddcode/contracts'
import { approvalSetup } from './permissions.ts'
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

/** The agent's per-session settings (model, thinking level, ...) in our own shape. */
export function toConfigOptions(options: SessionConfigOption[] | null | undefined): ConfigOption[] {
  return (options ?? []).map((o): ConfigOption => {
    const base = {
      id: o.id,
      name: o.name,
      description: o.description ?? undefined,
      category: o.category ?? undefined,
    }
    if (o.type === 'boolean') return { ...base, type: 'boolean', value: o.currentValue }
    const choices = (o.options as unknown[]).flatMap((entry) => {
      const e = entry as {
        value?: string
        name: string
        description?: string | null
        group?: string
        options?: unknown[]
      }
      // A group holds options of its own; a plain entry is itself an option.
      return Array.isArray(e.options)
        ? (e.options as { value: string; name: string; description?: string | null }[]).map(
            (c) => ({
              value: c.value,
              name: c.name,
              description: c.description ?? undefined,
              group: e.name,
            }),
          )
        : [{ value: String(e.value), name: e.name, description: e.description ?? undefined }]
    })
    return { ...base, type: 'select', value: o.currentValue, choices }
  })
}

interface ToolState {
  title: string
  kind: ToolKind
  done: boolean
  /** Latest diff per path, emitted once the tool succeeds. */
  diffs: Map<string, { path: string; oldText?: string | null; newText: string }>
  output?: string
  input?: string
  paths?: string[]
}

/** The tool's arguments as pretty JSON, capped; nothing for an empty object. */
export function inputText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return raw.trim() ? raw.slice(0, MAX_OUTPUT) : undefined
  if (typeof raw === 'object' && Object.keys(raw as object).length === 0) return undefined
  let text: string | undefined
  try {
    text = JSON.stringify(raw, null, 2)
  } catch {
    text = String(raw)
  }
  return text ? text.slice(0, MAX_OUTPUT) : undefined
}

function pathsOf(locations: { path: string }[] | null | undefined): string[] | undefined {
  const paths = [...new Set((locations ?? []).map((l) => l.path).filter(Boolean))]
  return paths.length > 0 ? paths : undefined
}

const sameList = (a: string[] | undefined, b: string[] | undefined) =>
  (a ?? []).join('\n') === (b ?? []).join('\n')

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

/** Grok (and others) put the tool's real kind in `_meta` when the first notification has none. */
function metaKind(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (!/(^|\/)tool$/.test(key) || !value || typeof value !== 'object') continue
    const kind = (value as { kind?: unknown }).kind
    if (typeof kind === 'string') return kind
  }
  return undefined
}

/**
 * Converts ACP `session/update` notifications into the shared event vocabulary. Edits arrive as
 * diff content on a tool call; the diff is emitted when the call completes successfully.
 */
export class AcpEventMapper {
  private turnId: string | undefined
  /** The session's cost so far, as `usage_update` reports it (cumulative). */
  private costSeen = 0
  private costFromTurns = false
  /** A resumed conversation's first total holds its earlier turns, counted when they ran. */
  private costBaseline = false
  private modes: { id: string; label: string; description?: string; dangerous?: boolean }[] = []
  private readonly tools = new Map<string, ToolState>()
  /** Tool calls the agent asked the user about (`session/request_permission`). */
  private readonly asked = new Set<string>()

  constructor(
    private readonly sessionId: string,
    private readonly now: () => number = Date.now,
  ) {}

  setTurn(turnId: string | undefined) {
    this.turnId = turnId
  }

  /** This continues an earlier conversation: its first cost total is a starting point, not new. */
  continuesEarlierConversation() {
    this.costBaseline = true
  }

  /** The agent gives cost with each turn's usage, so the running total is not counted again. */
  noteTurnCost() {
    this.costFromTurns = true
  }

  setModes(modes: { id: string; label: string; description?: string; dangerous?: boolean }[]) {
    this.modes = modes
  }

  /** Records that the agent asked the user before running this tool call. */
  noteApproval(toolId: string) {
    this.asked.add(toolId)
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
        const state = this.track(
          update.toolCallId,
          update.title,
          out,
          update.kind ?? metaKind(update._meta),
          inputText(update.rawInput),
          pathsOf(update.locations),
        )
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
          out,
          update.kind ?? metaKind(update._meta),
          inputText(update.rawInput),
          pathsOf(update.locations),
        )
        this.collectDiffs(state, update.content)
        state.output = textOf(update.content) ?? rawOutputText(update.rawOutput) ?? state.output
        if (update.status === 'completed' || update.status === 'failed') {
          this.finish(update.toolCallId, state, update.status === 'completed', out)
        }
        break
      }

      case 'plan':
        out.push({
          type: 'plan.updated',
          steps: update.entries.map((e) => ({
            text: e.content,
            status:
              e.status === 'completed'
                ? ('completed' as const)
                : e.status === 'in_progress'
                  ? ('in-progress' as const)
                  : ('pending' as const),
          })),
        })
        break

      case 'available_commands_update':
        out.push({
          type: 'session.commands',
          commands: update.availableCommands.map((c) => ({
            name: c.name,
            description: c.description || undefined,
            hint: c.input?.hint || undefined,
            kind: 'command' as const,
          })),
        })
        break

      case 'config_option_update': {
        // The mode option has its own picker: announce it as modes, the rest as settings.
        const setup = approvalSetup(undefined, toConfigOptions(update.configOptions))
        if (setup.source === 'config') {
          this.modes = setup.modes
          out.push({ type: 'session.modes', modes: setup.modes, currentModeId: setup.current })
        }
        out.push({ type: 'session.config', options: setup.rest })
        break
      }

      case 'usage_update': {
        // The window the agent's context fills, and its running cost for the session.
        if (update.size > 0) {
          out.push({ type: 'session.context', used: update.used, size: update.size })
        }
        const cost = update.cost
        if (cost && cost.currency === 'USD' && this.costBaseline) {
          this.costSeen = cost.amount
          this.costBaseline = false
        } else if (cost && cost.currency === 'USD' && cost.amount >= this.costSeen) {
          const delta = cost.amount - this.costSeen
          this.costSeen = cost.amount
          // An agent that reports cost with each turn's usage has it counted there already.
          if (delta > 0 && !this.costFromTurns) {
            out.push({
              type: 'session.usage',
              inputTokens: 0,
              outputTokens: 0,
              costUsd: delta,
            })
          }
        }
        break
      }

      case 'session_info_update':
        if (typeof update.title === 'string' && update.title.trim()) {
          out.push({ type: 'session.renamed', title: update.title.trim().slice(0, 120) })
        }
        break

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

  /**
   * Registers a tool the first time it is seen, announcing it to the UI. Agents often name a tool
   * by its function first (`run_terminal_command`) and only later say what it does
   * (``Execute `ls` ``) and what kind it is; those refinements go out as `tool.updated`.
   */
  private track(
    id: string,
    title: string | undefined,
    out: Draft[],
    kind: string | null | undefined,
    input?: string,
    paths?: string[],
  ): ToolState {
    let state = this.tools.get(id)
    if (!state) {
      state = {
        title: title ?? id,
        kind: toolKind(kind),
        done: false,
        diffs: new Map(),
        input,
        paths,
      }
      this.tools.set(id, state)
      out.push({
        type: 'tool.started',
        toolId: id,
        kind: state.kind,
        title: state.title,
        ...(input ? { input } : {}),
        ...(paths ? { paths } : {}),
      })
      return state
    }
    if (state.done) return state
    const nextKind = kind ? toolKind(kind) : state.kind
    const nextTitle = title?.trim() ? title : state.title
    const kindChanged = nextKind !== state.kind && nextKind !== 'other'
    const titleChanged = nextTitle !== state.title
    const inputChanged = input !== undefined && input !== state.input
    const pathsChanged = paths !== undefined && !sameList(paths, state.paths)
    if (kindChanged || titleChanged || inputChanged || pathsChanged) {
      if (kindChanged) state.kind = nextKind
      state.title = nextTitle
      if (inputChanged) state.input = input
      if (pathsChanged) state.paths = paths
      out.push({
        type: 'tool.updated',
        toolId: id,
        ...(kindChanged ? { kind: state.kind } : {}),
        ...(titleChanged ? { title: state.title } : {}),
        ...(inputChanged ? { input } : {}),
        ...(pathsChanged ? { paths } : {}),
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
    out.push({
      type: 'tool.completed',
      toolId: id,
      ok,
      output: state.output,
      approval: this.asked.delete(id) ? 'asked' : 'not-asked',
    })
    if (ok) {
      for (const d of state.diffs.values()) {
        out.push({ type: 'diff', path: d.path, ...diffText(d.oldText, d.newText) })
      }
    }
  }
}
