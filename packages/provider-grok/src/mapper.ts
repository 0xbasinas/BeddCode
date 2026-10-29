import type { SessionEvent } from '@beddcode/contracts'
import { grokCompaction } from './hooks.ts'
import { diffText } from '@beddcode/shared'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never
type Obj = Record<string, unknown>
type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'other'

const MAX_OUTPUT = 4_000
const MAX_TITLE = 200

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export function toolKind(kind: unknown): ToolKind {
  switch (kind) {
    case 'execute':
      return 'command'
    case 'read':
    case 'list':
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

/** The tool's arguments as pretty JSON, capped; nothing for an empty object. */
export function inputText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return raw.trim() ? raw.slice(0, MAX_OUTPUT) : undefined
  if (isObj(raw) && Object.keys(raw).length === 0) return undefined
  try {
    return JSON.stringify(raw, null, 2).slice(0, MAX_OUTPUT)
  } catch {
    return undefined
  }
}

/** The text of a tool's content blocks. */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content
    .flatMap((block) => {
      const inner = isObj(block) && block.type === 'content' ? block.content : undefined
      return isObj(inner) && inner.type === 'text' && typeof inner.text === 'string'
        ? [inner.text]
        : []
    })
    .join('\n')
  return text.trim() ? text.slice(0, MAX_OUTPUT) : undefined
}

/** Keys that hold what a tool printed, most readable first. */
const OUTPUT_KEYS = ['stdout', 'output', 'raw_output', 'content', 'text', 'result']

/**
 * What a tool printed, from its raw output. Grok wraps it by tool (`{ type: 'ListDir', Content:
 * { content } }`), so the first readable string under a known key is taken; any other object is
 * shown as JSON.
 */
export function rawOutputText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return raw.trim() ? raw.slice(0, MAX_OUTPUT) : undefined
  const found = findText(raw, 4)
  if (found) return found.slice(0, MAX_OUTPUT)
  try {
    return JSON.stringify(raw).slice(0, MAX_OUTPUT)
  } catch {
    return undefined
  }
}

function findText(value: unknown, depth: number): string | undefined {
  if (!isObj(value) || depth === 0) return undefined
  for (const key of OUTPUT_KEYS) {
    const v = value[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  for (const v of Object.values(value)) {
    const nested = findText(v, depth - 1)
    if (nested) return nested
  }
  return undefined
}

function pathsOf(locations: unknown): string[] | undefined {
  if (!Array.isArray(locations)) return undefined
  const paths = [
    ...new Set(locations.flatMap((l) => (isObj(l) && str(l.path) ? [l.path as string] : []))),
  ]
  return paths.length > 0 ? paths : undefined
}

/** A shell tool is titled by the command it runs; any other tool by its name. */
function titleOf(line: Obj, kind: ToolKind): string {
  const raw = isObj(line.rawInput) ? line.rawInput : undefined
  const command = kind === 'command' ? (str(raw?.command) ?? str(raw?.cmd)) : undefined
  const title = command ?? str(line.title) ?? str(line.toolName) ?? 'Tool'
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

interface ToolState {
  kind: ToolKind
  title: string
  done: boolean
  input?: string
  paths?: string[]
  output?: string
  diffs: Map<string, { path: string; oldText?: string | null; newText: string }>
}

/**
 * Converts the lines of `grok --output-format streaming-json` into the shared event vocabulary.
 * Lines of a type it does not know are ignored, as Grok's own documentation asks of readers.
 */
export class GrokEventMapper {
  private turnId: string | undefined
  private readonly tools = new Map<string, ToolState>()
  /** Grok repeats the command list with every step; only a change is news. */
  private commandsKey = ''

  constructor(
    private readonly sessionId: string,
    private readonly now: () => number = Date.now,
  ) {}

  setTurn(turnId: string | undefined) {
    this.turnId = turnId
  }

  /** Tools still running when a turn ends early are closed, so none is left spinning. */
  abandonOpenTools(): SessionEvent[] {
    const out: Draft[] = []
    for (const [id, state] of this.tools) {
      if (state.done) continue
      state.done = true
      out.push({ type: 'tool.completed', toolId: id, ok: false, approval: 'not-asked' })
    }
    return this.stamp(out)
  }

  map(line: unknown): SessionEvent[] {
    if (!isObj(line)) return []
    const out: Draft[] = []

    switch (line.type) {
      case 'text':
        if (typeof line.data === 'string' && line.data) {
          out.push({ type: 'message.delta', role: 'assistant', text: line.data })
        }
        break

      case 'tool_call':
        this.toolCall(line, out)
        break

      case 'tool_call_update':
        this.toolUpdate(line, out)
        break

      case 'plan': {
        const entries = Array.isArray(line.entries) ? line.entries : []
        out.push({
          type: 'plan.updated',
          steps: entries.filter(isObj).map((e) => ({
            text: str(e.content) ?? '',
            status:
              e.status === 'completed'
                ? ('completed' as const)
                : e.status === 'in_progress'
                  ? ('in-progress' as const)
                  : ('pending' as const),
          })),
        })
        break
      }

      case 'auto_compact_started':
      case 'auto_compact_completed':
      case 'auto_compact_failed': {
        const compaction = grokCompaction({ sessionUpdate: line.type, ...line })
        if (compaction) out.push(compaction)
        break
      }

      case 'available_commands': {
        const names = Array.isArray(line.commands)
          ? line.commands.flatMap((c) =>
              typeof c === 'string' ? [c] : isObj(c) && str(c.name) ? [c.name as string] : [],
            )
          : []
        const key = names.join('\n')
        if (names.length > 0 && key !== this.commandsKey) {
          this.commandsKey = key
          out.push({
            type: 'session.commands',
            commands: names.map((name) => ({ name, kind: 'command' as const })),
          })
        }
        break
      }
    }
    return this.stamp(out)
  }

  private toolCall(line: Obj, out: Draft[]) {
    const id = str(line.toolCallId)
    if (!id) return
    const kind = toolKind(line.kind)
    const input = inputText(line.rawInput)
    const paths = pathsOf(line.locations)
    let state = this.tools.get(id)
    if (!state) {
      state = { kind, title: titleOf(line, kind), done: false, input, paths, diffs: new Map() }
      this.tools.set(id, state)
      out.push({
        type: 'tool.started',
        toolId: id,
        kind,
        title: state.title,
        ...(input ? { input } : {}),
        ...(paths ? { paths } : {}),
      })
    }
    this.absorb(state, line)
    if (line.status === 'completed' || line.status === 'failed') {
      this.finish(id, state, line.status === 'completed', out)
    }
  }

  private toolUpdate(line: Obj, out: Draft[]) {
    const id = str(line.toolCallId)
    const state = id ? this.tools.get(id) : undefined
    if (!id || !state || state.done) return
    const paths = pathsOf(line.locations)
    const input = inputText(line.rawInput)
    const pathsChanged = paths !== undefined && paths.join('\n') !== (state.paths ?? []).join('\n')
    const inputChanged = input !== undefined && input !== state.input
    if (pathsChanged || inputChanged) {
      if (pathsChanged) state.paths = paths
      if (inputChanged) state.input = input
      out.push({
        type: 'tool.updated',
        toolId: id,
        ...(inputChanged ? { input } : {}),
        ...(pathsChanged ? { paths } : {}),
      })
    }
    this.absorb(state, line)
    if (line.status === 'completed' || line.status === 'failed') {
      this.finish(id, state, line.status === 'completed', out)
    }
  }

  /** Keeps the output and any diffs a tool call or update carries. */
  private absorb(state: ToolState, line: Obj) {
    state.output = contentText(line.content) ?? rawOutputText(line.rawOutput) ?? state.output
    if (!Array.isArray(line.content)) return
    for (const block of line.content) {
      if (!isObj(block) || block.type !== 'diff' || !str(block.path)) continue
      const path = block.path as string
      state.diffs.set(path.replace(/\\/g, '/'), {
        path,
        oldText: typeof block.oldText === 'string' ? block.oldText : null,
        newText: typeof block.newText === 'string' ? block.newText : '',
      })
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
      approval: 'not-asked',
    })
    if (ok) {
      for (const d of state.diffs.values()) {
        out.push({ type: 'diff', path: d.path, ...diffText(d.oldText, d.newText) })
      }
    }
  }

  private stamp(drafts: Draft[]): SessionEvent[] {
    return drafts.map(
      (e) =>
        ({ ...e, sessionId: this.sessionId, turnId: this.turnId, at: this.now() }) as SessionEvent,
    )
  }
}

/** What the `end` line says a turn used: one entry per model, or one without a name. */
export function usageFromEnd(end: Obj): Draft[] {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  const perModel = isObj(end.modelUsage) ? Object.entries(end.modelUsage) : []
  const rows = perModel.flatMap(([model, u]) =>
    isObj(u)
      ? [
          {
            model,
            inputTokens: num(u.inputTokens),
            outputTokens: num(u.outputTokens),
            cacheReadTokens: num(u.cacheReadInputTokens),
            cacheWriteTokens: num(u.cacheCreationInputTokens),
            costUsd: typeof u.costUSD === 'number' ? u.costUSD : undefined,
          },
        ]
      : [],
  )
  if (rows.length === 0) {
    const u = isObj(end.usage) ? end.usage : undefined
    if (!u && typeof end.total_cost_usd !== 'number') return []
    rows.push({
      model: undefined as unknown as string,
      inputTokens: num(u?.input_tokens),
      outputTokens: num(u?.output_tokens),
      cacheReadTokens: num(u?.cache_read_input_tokens),
      cacheWriteTokens: num(u?.cache_creation_input_tokens),
      costUsd: typeof end.total_cost_usd === 'number' ? end.total_cost_usd : undefined,
    })
  }
  return rows
    .filter((r) => r.inputTokens + r.outputTokens + r.cacheReadTokens + (r.costUsd ?? 0) > 0)
    .map((r) => ({
      type: 'session.usage' as const,
      ...(r.model ? { model: r.model } : {}),
      inputTokens: Math.round(r.inputTokens),
      outputTokens: Math.round(r.outputTokens),
      ...(r.cacheReadTokens ? { cacheReadTokens: Math.round(r.cacheReadTokens) } : {}),
      ...(r.cacheWriteTokens ? { cacheWriteTokens: Math.round(r.cacheWriteTokens) } : {}),
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
    }))
}
