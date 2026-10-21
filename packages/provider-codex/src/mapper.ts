import type { SessionEvent } from '@beddcode/contracts'
import { displayPath } from '@beddcode/shared'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never
type Obj = Record<string, unknown>

const MAX_OUTPUT = 4_000
const MAX_PATCH_LINES = 400

/** One item of a Codex thread, as carried by `item/started` and `item/completed`. */
export interface CodexItem extends Obj {
  type: string
  id: string
}

export interface FileChange {
  path: string
  kind: { type: 'add' | 'delete' | 'update' }
  diff: string
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Codex runs shell commands through a wrapper such as `pwsh.exe -Command "..."` or
 * `bash -lc '...'`. Show what the user would recognise: the inner command.
 */
export function commandTitle(command: string): string {
  const inner =
    /^(?:"[^"]*"|\S+)\s+-Command\s+(['"])(.*)\1$/s.exec(command)?.[2] ??
    /^(?:"[^"]*"|\S+)\s+-l?c\s+(['"])(.*)\1$/s.exec(command)?.[2] ??
    command
  const firstLine = inner.split('\n')[0] ?? inner
  return `Running ${clip(firstLine, 200)}${inner.includes('\n') ? ' …' : ''}`
}

export function fileChangeTitle(changes: FileChange[], cwd?: string): string {
  if (changes.length === 1) return `Editing ${displayPath(changes[0]!.path, cwd)}`
  return `Editing ${changes.length} files`
}

const isDiffMeta = (l: string) => l.startsWith('+++') || l.startsWith('---')

/** Turns one file's change into a patch plus +/- counts. */
export function diffForChange(change: FileChange, cwd?: string) {
  const file = displayPath(change.path, cwd)
  const body = change.diff.endsWith('\n') ? change.diff.slice(0, -1) : change.diff
  let lines: string[]
  if (change.kind.type === 'add') lines = body.split('\n').map((l) => `+${l}`)
  else if (change.kind.type === 'delete') lines = body.split('\n').map((l) => `-${l}`)
  else lines = body.split('\n').filter((l) => !isDiffMeta(l))

  const added = lines.filter((l) => l.startsWith('+')).length
  const removed = lines.filter((l) => l.startsWith('-')).length
  return { path: file, added, removed, patch: lines.slice(0, MAX_PATCH_LINES).join('\n') }
}

/**
 * Converts Codex app-server notifications into the shared event vocabulary. Agent text arrives as
 * deltas plus a final item; only the final item of a message that was never streamed is emitted.
 */
export class CodexEventMapper {
  private turnId: string | undefined
  private readonly streamed = new Set<string>()
  private readonly items = new Map<string, CodexItem>()

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly now: () => number = Date.now,
  ) {}

  setTurn(turnId: string | undefined) {
    this.turnId = turnId
  }

  /** Items seen so far, so approval requests can describe the item they refer to. */
  item(itemId: string): CodexItem | undefined {
    return this.items.get(itemId)
  }

  map(method: string, params: unknown): SessionEvent[] {
    const p = (params ?? {}) as Obj
    const out: Draft[] = []

    switch (method) {
      case 'item/agentMessage/delta': {
        const text = str(p.delta)
        if (text) {
          this.streamed.add(String(p.itemId))
          out.push({ type: 'message.delta', role: 'assistant', text })
        }
        break
      }
      case 'turn/plan/updated': {
        const steps = Array.isArray(p.plan) ? (p.plan as Obj[]) : []
        out.push({
          type: 'plan.updated',
          steps: steps.map((step) => ({
            text: str(step.step) ?? '',
            status:
              step.status === 'completed'
                ? ('completed' as const)
                : step.status === 'inProgress'
                  ? ('in-progress' as const)
                  : ('pending' as const),
          })),
          explanation: str(p.explanation),
        })
        break
      }
      case 'item/started':
        this.onItemStarted(p.item as CodexItem, out)
        break
      case 'item/completed':
        this.onItemCompleted(p.item as CodexItem, out)
        break
      case 'error': {
        if (p.willRetry === true) break
        const err = (p.error ?? {}) as Obj
        out.push({ type: 'error', message: str(err.message) ?? 'Codex reported an error' })
        break
      }
      case 'turn/completed': {
        const turn = (p.turn ?? {}) as Obj
        const status = turn.status
        if (status === 'interrupted') out.push({ type: 'turn.completed', reason: 'cancelled' })
        else if (status === 'failed') {
          const err = (turn.error ?? {}) as Obj
          out.push({ type: 'error', message: str(err.message) ?? 'The turn failed' })
          out.push({ type: 'turn.completed', reason: 'error' })
        } else out.push({ type: 'turn.completed', reason: 'done' })
        this.streamed.clear()
        break
      }
    }

    return out.map(
      (e) =>
        ({ ...e, sessionId: this.sessionId, turnId: this.turnId, at: this.now() }) as SessionEvent,
    )
  }

  private onItemStarted(item: CodexItem | undefined, out: Draft[]) {
    if (!item) return
    this.items.set(item.id, item)
    switch (item.type) {
      case 'commandExecution':
        out.push({
          type: 'tool.started',
          toolId: item.id,
          kind: 'command',
          title: commandTitle(String(item.command ?? '')),
        })
        break
      case 'fileChange':
        out.push({
          type: 'tool.started',
          toolId: item.id,
          kind: 'edit',
          title: fileChangeTitle(item.changes as FileChange[], this.cwd),
        })
        break
      case 'mcpToolCall':
        out.push({
          type: 'tool.started',
          toolId: item.id,
          kind: 'other',
          title: `Using ${String(item.server)} · ${String(item.tool)}`,
        })
        break
      case 'dynamicToolCall':
        out.push({
          type: 'tool.started',
          toolId: item.id,
          kind: 'other',
          title: `Using ${String(item.tool)}`,
        })
        break
      case 'webSearch':
        out.push({
          type: 'tool.started',
          toolId: item.id,
          kind: 'search',
          title: `Searching ${clip(str(item.query) ?? 'the web', 200)}`,
        })
        break
    }
  }

  private onItemCompleted(item: CodexItem | undefined, out: Draft[]) {
    if (!item) return
    this.items.delete(item.id)
    switch (item.type) {
      case 'agentMessage': {
        const text = str(item.text)
        if (text && !this.streamed.has(item.id))
          out.push({ type: 'message.delta', role: 'assistant', text })
        this.streamed.delete(item.id)
        break
      }
      case 'commandExecution': {
        const ok = item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null)
        const output = str(item.aggregatedOutput)
        out.push({
          type: 'tool.completed',
          toolId: item.id,
          ok,
          output: output ? output.slice(0, MAX_OUTPUT) : undefined,
        })
        break
      }
      case 'fileChange': {
        const ok = item.status === 'completed'
        out.push({ type: 'tool.completed', toolId: item.id, ok })
        if (ok) {
          for (const change of item.changes as FileChange[]) {
            out.push({ type: 'diff', ...diffForChange(change, this.cwd) })
          }
        }
        break
      }
      case 'mcpToolCall':
      case 'dynamicToolCall': {
        const failed = item.status === 'failed' || item.error != null || item.success === false
        out.push({ type: 'tool.completed', toolId: item.id, ok: !failed })
        break
      }
      case 'webSearch':
        out.push({ type: 'tool.completed', toolId: item.id, ok: true })
        break
    }
  }
}
