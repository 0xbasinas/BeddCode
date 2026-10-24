import type { ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '@beddcode/contracts'
import { displayPath } from '@beddcode/shared'

type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'other'
type Block = { type: string; [key: string]: unknown }

/** Distributive Omit so each event variant keeps its own fields. */
type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never

interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}
const ZERO: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }

const MAX_OUTPUT = 4_000
const MAX_PATCH_LINES = 400

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export function toolKind(name: string): ToolKind {
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return 'command'
  if (name === 'Read') return 'read'
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (['Grep', 'Glob', 'WebSearch', 'WebFetch'].includes(name)) return 'search'
  return 'other'
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function toolTitle(name: string, input: Record<string, unknown>, cwd?: string): string {
  const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s)
  const raw = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  const file = raw ? displayPath(raw, cwd) : undefined
  switch (toolKind(name)) {
    case 'command':
      return `Running Bash: ${clip(str(input.command) ?? name)}`
    case 'read':
      return `Reading ${file ?? 'file'}`
    case 'edit':
      return `Editing ${file ?? 'file'}`
    case 'search':
      return `Searching ${clip(str(input.pattern) ?? str(input.query) ?? str(input.url) ?? '')}`.trim()
    default:
      return str(input.description) ?? `Using ${name.replace(/^mcp__/, '').replace(/__/g, ' · ')}`
  }
}

interface DiffPart {
  path: string
  patch: string
  added: number
  removed: number
}

function prefixed(text: string, prefix: '+' | '-'): string[] {
  return text.length === 0 ? [] : text.split('\n').map((l) => `${prefix}${l}`)
}

/** Builds a simple removed/added patch from the tool input; the real diff is the file on disk. */
export function diffForTool(name: string, input: Record<string, unknown>): DiffPart | null {
  const file = str(input.file_path) ?? str(input.notebook_path)
  if (!file) return null
  const lines: string[] = []
  let added = 0
  let removed = 0

  const pair = (oldText: unknown, newText: unknown) => {
    const del = prefixed(typeof oldText === 'string' ? oldText : '', '-')
    const add = prefixed(typeof newText === 'string' ? newText : '', '+')
    removed += del.length
    added += add.length
    lines.push(...del, ...add)
  }

  if (name === 'Edit') pair(input.old_string, input.new_string)
  else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const edit of input.edits as Record<string, unknown>[])
      pair(edit.old_string, edit.new_string)
  } else if (name === 'Write') pair('', input.content)
  else if (name === 'NotebookEdit') pair('', input.new_source)
  else return null

  const patch = lines.slice(0, MAX_PATCH_LINES).join('\n')
  return { path: file, patch, added, removed }
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : []
}

/** A tool's arguments as pretty JSON (capped), or nothing for none. */
function argsText(input: Record<string, unknown>): { input?: string } {
  if (Object.keys(input).length === 0) return {}
  try {
    return { input: JSON.stringify(input, null, 2).slice(0, MAX_OUTPUT) }
  } catch {
    return {}
  }
}

function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.slice(0, MAX_OUTPUT)
  const text = blocks(content)
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n')
  return text ? text.slice(0, MAX_OUTPUT) : undefined
}

/**
 * Converts Claude Agent SDK messages into the shared event vocabulary. Text arrives as streamed
 * deltas; tool calls come from the complete assistant message (full input); an edit's diff is
 * emitted only once its tool result reports success.
 */
export class ClaudeEventMapper {
  private turnId: string | undefined
  private interrupted = false
  private readonly streamedMessages = new Set<string>()
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown> }>()
  /** Tool calls shown another way (the to-do list is the plan, not a tool row). */
  private readonly hidden = new Set<string>()
  /** The running totals last seen per model; each result carries them cumulatively. */
  private readonly usageSeen = new Map<string, UsageTotals>()
  private firstResult = true

  constructor(
    private readonly sessionId: string,
    private readonly options: {
      cwd?: string
      now?: () => number
      /** Continues an earlier conversation, so the first totals include turns counted before. */
      resumed?: boolean
    } = {},
  ) {}

  setTurn(turnId: string | undefined) {
    this.turnId = turnId
  }

  markInterrupted() {
    this.interrupted = true
  }

  /**
   * What this turn added: the SDK reports running totals per model for the whole conversation, so
   * the turn's share is the difference from the last result. A resumed conversation's first totals
   * already hold its earlier turns (counted when they ran), so they only set the starting point.
   */
  private usageSince(modelUsage: Record<string, ModelUsage> | undefined): Draft[] {
    const out: Draft[] = []
    for (const [model, now] of Object.entries(modelUsage ?? {})) {
      const current: UsageTotals = {
        input: now.inputTokens,
        output: now.outputTokens,
        cacheRead: now.cacheReadInputTokens,
        cacheWrite: now.cacheCreationInputTokens,
        cost: now.costUSD,
      }
      const before = this.usageSeen.get(model)
      this.usageSeen.set(model, current)
      if (this.firstResult && this.options.resumed) continue
      // Totals that went down mean the count started over (a /clear): all of it is new.
      const reset = before !== undefined && current.input < before.input
      const base: UsageTotals = !before || reset ? ZERO : before
      const delta = {
        input: current.input - base.input,
        output: current.output - base.output,
        cacheRead: current.cacheRead - base.cacheRead,
        cacheWrite: current.cacheWrite - base.cacheWrite,
        cost: Math.max(0, current.cost - base.cost),
      }
      if (delta.input + delta.output + delta.cacheRead + delta.cacheWrite <= 0) continue
      out.push({
        type: 'session.usage',
        model,
        inputTokens: Math.max(0, delta.input),
        outputTokens: Math.max(0, delta.output),
        cacheReadTokens: Math.max(0, delta.cacheRead),
        cacheWriteTokens: Math.max(0, delta.cacheWrite),
        costUsd: delta.cost > 0 ? delta.cost : undefined,
      })
    }
    this.firstResult = false
    return out
  }

  /** The provider session id, if this message announces it. */
  providerSessionId(msg: SDKMessage): string | undefined {
    return msg.type === 'system' && msg.subtype === 'init' ? msg.session_id : undefined
  }

  map(msg: SDKMessage): SessionEvent[] {
    const out: Draft[] = []

    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          out.push({ type: 'session.provider-session', providerSessionId: msg.session_id })
        }
        break

      case 'stream_event': {
        if (msg.parent_tool_use_id !== null) break
        const event = msg.event as { type: string; message?: { id?: string }; delta?: Block }
        if (event.type === 'message_start' && event.message?.id) {
          this.streamedMessages.add(event.message.id)
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = str(event.delta.text)
          if (text) out.push({ type: 'message.delta', role: 'assistant', text })
        }
        break
      }

      case 'assistant': {
        const alreadyStreamed = this.streamedMessages.has(msg.message.id)
        for (const block of blocks(msg.message.content)) {
          if (block.type === 'text' && !alreadyStreamed && msg.parent_tool_use_id === null) {
            const text = str(block.text)
            if (text) out.push({ type: 'message.delta', role: 'assistant', text })
          } else if (block.type === 'tool_use') {
            const toolId = String(block.id)
            const name = String(block.name)
            const input = (block.input ?? {}) as Record<string, unknown>
            // Looking up other tools is the agent's own plumbing, not something the user did or needs to see.
            if (name === 'ToolSearch') {
              this.hidden.add(toolId)
              continue
            }
            if (name === 'TodoWrite' && Array.isArray(input.todos)) {
              this.hidden.add(toolId)
              out.push({
                type: 'plan.updated',
                steps: (input.todos as Record<string, unknown>[]).map((t) => ({
                  text:
                    str(t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content) ?? '',
                  status:
                    t.status === 'completed'
                      ? ('completed' as const)
                      : t.status === 'in_progress'
                        ? ('in-progress' as const)
                        : ('pending' as const),
                })),
              })
              continue
            }
            this.tools.set(toolId, { name, input })
            out.push({
              type: 'tool.started',
              toolId,
              kind: toolKind(name),
              title: toolTitle(name, input, this.options.cwd),
              // MCP tools (BeddCode's agent tools among them) carry no title of their own worth
              // reading; their arguments let the UI say what they do.
              ...(name.startsWith('mcp__') ? argsText(input) : {}),
            })
          }
        }
        break
      }

      case 'user': {
        for (const block of blocks(msg.message.content)) {
          if (block.type !== 'tool_result') continue
          const toolId = String(block.tool_use_id)
          if (this.hidden.delete(toolId)) continue
          const ok = block.is_error !== true
          out.push({ type: 'tool.completed', toolId, ok, output: resultText(block.content) })
          const tool = this.tools.get(toolId)
          this.tools.delete(toolId)
          if (ok && tool) {
            const diff = diffForTool(tool.name, tool.input)
            if (diff) out.push({ type: 'diff', ...diff })
          }
        }
        break
      }

      case 'result': {
        const failed = msg.is_error || msg.subtype !== 'success'
        if (this.interrupted) {
          out.push({ type: 'turn.completed', reason: 'cancelled' })
        } else if (failed) {
          const detail =
            'errors' in msg && msg.errors.length > 0 ? msg.errors.join('\n') : undefined
          out.push({
            type: 'error',
            message: detail ?? ('result' in msg ? msg.result : msg.subtype),
          })
          out.push({ type: 'turn.completed', reason: 'error' })
        } else {
          out.push({ type: 'turn.completed', reason: 'done' })
        }
        out.push(...this.usageSince(msg.modelUsage))
        this.interrupted = false
        this.streamedMessages.clear()
        break
      }

      default:
        break
    }

    return out.map(
      (e) =>
        ({
          ...e,
          sessionId: this.sessionId,
          turnId: this.turnId,
          at: (this.options.now ?? Date.now)(),
        }) as SessionEvent,
    )
  }
}
