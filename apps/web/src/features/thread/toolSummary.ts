import type { TranscriptItem } from '@beddcode/client-runtime'

export type Tool = Extract<TranscriptItem, { kind: 'tool' }>

/** "820 ms", "3.4 s", "2 m 05 s": short enough to sit at the end of a row. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)} s`
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.floor(s / 60)
  return `${m} m ${String(Math.round(s - m * 60)).padStart(2, '0')} s`
}

/**
 * How long a tool actually ran, or has been running so far. Time spent waiting for the user to
 * approve it does not count (see `approvalWait`); a tool still waiting has no run time yet.
 */
export function toolDuration(tool: Tool, now = Date.now()): number | undefined {
  if (tool.startedAt === undefined) return undefined
  const approval = tool.approval
  if (approval && approval.resolvedAt === undefined && tool.status === 'running') return undefined
  const from = approval?.resolvedAt ?? tool.startedAt
  return Math.max(0, (tool.status === 'running' ? now : (tool.endedAt ?? now)) - from)
}

/** How long the tool waited for the user's answer, when the agent asked first. */
export function approvalWait(tool: Tool, now = Date.now()): number | undefined {
  const approval = tool.approval
  if (!approval) return undefined
  const end = approval.resolvedAt ?? (tool.status === 'running' ? now : tool.endedAt)
  return end === undefined ? undefined : Math.max(0, end - approval.requestedAt)
}

export type ToolPhase =
  /** The agent asked and is waiting on the user. */
  | 'awaiting-approval'
  /** The user allowed it; the agent has not reported it finished yet. */
  | 'approved'
  /** The user said no; the agent has not reported back yet. */
  | 'denied'
  | Tool['status']

/** Where a tool stands, including the user's answer while the agent catches up. */
export function toolPhase(tool: Tool): ToolPhase {
  if (tool.status !== 'running' || !tool.approval) return tool.status
  const { resolvedAt, outcome } = tool.approval
  if (resolvedAt === undefined) return 'awaiting-approval'
  if (outcome === 'deny') return 'denied'
  if (outcome === 'cancelled') return 'cancelled'
  return 'approved'
}

/**
 * True for a command or an edit the agent ran without asking the user, which the provider only
 * reports for agents that ask through BeddCode (ACP). Reads and searches never ask, so they are
 * not worth pointing out.
 */
export function ranWithoutAsking(tool: Tool): boolean {
  return tool.asked === false && (tool.toolKind === 'command' || tool.toolKind === 'edit')
}

const PLURAL: Record<Tool['toolKind'], [string, string, string]> = {
  command: ['ran', 'command', 'commands'],
  read: ['read', 'file', 'files'],
  edit: ['edited', 'file', 'files'],
  search: ['searched', 'time', 'times'],
  other: ['used', 'tool', 'tools'],
}
const ORDER: Tool['toolKind'][] = ['command', 'read', 'edit', 'search', 'other']

/** "Ran 2 commands, read 3 files": what a group of tool calls did, in one line. */
export function summarizeTools(tools: Tool[]): string {
  const parts = ORDER.flatMap((kind) => {
    const n = tools.filter((t) => t.toolKind === kind).length
    if (n === 0) return []
    const [verb, one, many] = PLURAL[kind]
    return [`${verb} ${n} ${n === 1 ? one : many}`]
  })
  const text = parts.join(', ')
  return text ? text[0]!.toUpperCase() + text.slice(1) : 'No tools'
}

/** [title pattern, while running, when done, marker before the target] */
const VERBS: [RegExp, string, string, string][] = [
  [/^Running Bash:\s*/i, 'Running', 'Ran', '$'],
  // ACP agents such as Grok: "Execute `ls -la`", "Edit `/a/b.py`", "Read `/a/b.py`".
  [/^Execute\s+/i, 'Running', 'Ran', '$'],
  [/^Edit\s+/i, 'Editing', 'Edited', ''],
  [/^Read\s+/i, 'Reading', 'Read', ''],
  [/^Running:?\s*/i, 'Running', 'Ran', '$'],
  [/^Reading\s+/i, 'Reading', 'Read', ''],
  [/^Editing\s+/i, 'Editing', 'Edited', ''],
  [/^Searching\s*/i, 'Searching', 'Searched', ''],
]

export interface ToolLabel {
  /** What it did, in the tense that fits its state ("Ran", "Reading"). */
  verb: string
  /** What it did it to: the command, the file, the query. */
  target: string
  /** A marker to show before the target, such as `$` for a shell command. */
  prompt: string
}

/** "`ls -la`" → "ls -la": a whole target in one pair of backticks is just quoted. */
function unquote(text: string): string {
  return /^`[^`]+`$/.test(text) ? text.slice(1, -1) : text
}

/** Splits a provider's tool title ("Running Bash: pnpm test") into a verb and its object. */
export function toolLabel(tool: Pick<Tool, 'title' | 'status'>): ToolLabel {
  for (const [pattern, running, done, prompt] of VERBS) {
    if (!pattern.test(tool.title)) continue
    const target = unquote(tool.title.replace(pattern, '').trim())
    const verb =
      tool.status === 'running' ? running : tool.status === 'cancelled' ? 'Stopped' : done
    return { verb, target, prompt }
  }
  return { verb: tool.status === 'cancelled' ? 'Stopped' : '', target: tool.title, prompt: '' }
}

/**
 * Whether a run of tool calls shows its rows. A short run, or one still going or that failed, is
 * open so nothing important hides; a long finished run folds into its summary.
 */
export function defaultOpen(tools: Tool[]): boolean {
  return (
    tools.length <= 2 ||
    tools.some((t) => t.status === 'running' || t.status === 'failed' || t.status === 'cancelled')
  )
}
