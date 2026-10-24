import type { SessionView, TranscriptItem } from '@beddcode/client-runtime/replica'

export type Phase = 'needs you' | 'running' | 'failed' | 'done' | 'idle'

/** What a session is doing, in the words `beddcode ls` uses. */
export function phaseOf(s: SessionView): Phase {
  if (s.status === 'needs-you') return 'needs you'
  if (s.status === 'running') return 'running'
  if (s.status === 'failed') return 'failed'
  return s.done ? 'done' : 'idle'
}

export function age(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

export const shortId = (id: string) => id.slice(0, 8)

const clip = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

export interface Row {
  host: string
  view: SessionView
}

/** The `beddcode ls` table. Newest activity first; the host column only when there are several. */
export function formatSessions(rows: Row[], now = Date.now(), width = 100): string {
  if (rows.length === 0) return 'No sessions.'
  const sorted = [...rows].sort((a, b) => b.view.updatedAt - a.view.updatedAt)
  const hosts = new Set(sorted.map((r) => r.host)).size > 1
  const cells = sorted.map((r) => [
    shortId(r.view.id),
    phaseOf(r.view),
    r.view.instanceId,
    ...(hosts ? [r.host] : []),
    age(r.view.updatedAt, now),
    r.view.title,
    r.view.projectless ? '(no project)' : (r.view.branch ?? ''),
  ])
  const head = ['ID', 'STATUS', 'AGENT', ...(hosts ? ['HOST'] : []), 'AGE', 'TITLE', 'BRANCH']
  const titleAt = head.indexOf('TITLE')
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)))
  const fixed = widths.reduce((sum, w, i) => (i === titleAt ? sum : sum + w + 2), 0)
  widths[titleAt] = Math.max(12, Math.min(widths[titleAt]!, width - fixed))
  const line = (c: string[]) =>
    c
      .map((cell, i) => (i === c.length - 1 ? cell : clip(cell, widths[i]!).padEnd(widths[i]!)))
      .join('  ')
      .trimEnd()
  return [line(head), ...cells.map(line)].join('\n')
}

export function sessionJson(r: Row) {
  const v = r.view
  return {
    host: r.host,
    id: v.id,
    title: v.title,
    status: phaseOf(v),
    agent: v.instanceId,
    cwd: v.cwd,
    branch: v.branch ?? null,
    worktree: v.worktree !== undefined,
    projectless: v.projectless === true,
    parent: v.parent?.sessionId ?? null,
    turns: v.completedTurns,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }
}

/** A session by full id, id prefix, `last`, or part of its title; an error says what is ambiguous. */
export function findSession(rows: Row[], query: string): Row {
  if (rows.length === 0) throw new Error('No sessions.')
  if (query === 'last') {
    return [...rows].sort((a, b) => b.view.updatedAt - a.view.updatedAt)[0]!
  }
  const exact = rows.filter((r) => r.view.id === query)
  if (exact.length === 1) return exact[0]!
  const q = query.toLowerCase()
  const byId = q.length >= 4 ? rows.filter((r) => r.view.id.toLowerCase().startsWith(q)) : []
  const pool = byId.length > 0 ? byId : rows.filter((r) => r.view.title.toLowerCase().includes(q))
  if (pool.length === 1) return pool[0]!
  if (pool.length === 0) throw new Error(`No session matches "${query}". See \`beddcode ls\`.`)
  const list = pool
    .slice(0, 8)
    .map((r) => `  ${shortId(r.view.id)}  ${r.view.title}`)
    .join('\n')
  throw new Error(`"${query}" matches ${pool.length} sessions; be more specific:\n${list}`)
}

/** Remembers what has been shown of a session, so each update prints only what is new. */
export interface Memo {
  seen: Map<string, string>
  textLength: Map<string, number>
}

export const newMemo = (): Memo => ({ seen: new Map(), textLength: new Map() })

export interface Output {
  /** What the agent says: the answer itself. */
  text: string[]
  /** What it does along the way: tools, changes, notices. */
  activity: string[]
}

/** Marks everything already in the session as shown, so a follower starts from now. */
export function markSeen(view: SessionView, memo: Memo): void {
  renderNew(view, memo)
}

const itemLine = (item: TranscriptItem): string | null => {
  switch (item.kind) {
    case 'tool':
      return `▸ ${item.title}`
    case 'changes':
      return `✎ changed ${item.files.length} file${item.files.length === 1 ? '' : 's'}`
    case 'notice':
      return `· ${item.message}`
    case 'error':
      return `✗ ${item.message}`
    default:
      return null
  }
}

/** The part of the transcript not shown yet: new answer text, and one line per tool or change. */
export function renderNew(view: SessionView, memo: Memo): Output {
  const out: Output = { text: [], activity: [] }
  for (const item of view.items) {
    if (item.kind === 'message') {
      if (item.role !== 'assistant') {
        memo.textLength.set(item.id, item.text.length)
        continue
      }
      const shown = memo.textLength.get(item.id) ?? 0
      if (item.text.length > shown) {
        out.text.push(item.text.slice(shown))
        memo.textLength.set(item.id, item.text.length)
      }
      continue
    }
    if (item.kind === 'tool') {
      const before = memo.seen.get(item.id)
      if (before === undefined) out.activity.push(itemLine(item)!)
      if (item.status !== 'running' && before !== item.status) {
        if (item.status === 'failed') out.activity.push('  ✗ failed')
        else if (item.status === 'cancelled') out.activity.push('  ✗ cancelled')
      }
      memo.seen.set(item.id, item.status)
      continue
    }
    if (memo.seen.has(item.id)) continue
    memo.seen.set(item.id, item.kind)
    const line = itemLine(item)
    if (line) out.activity.push(line)
  }
  return out
}

/** An approval or question the agent is waiting on, if any. */
export type Waiting =
  | { kind: 'approval'; item: Extract<TranscriptItem, { kind: 'approval' }> }
  | { kind: 'question'; item: Extract<TranscriptItem, { kind: 'question' }> }

export function waitingOn(view: SessionView): Waiting | null {
  for (const item of view.items) {
    if (item.kind === 'approval' && !item.resolvedOptionId && !item.cancelled) {
      return { kind: 'approval', item }
    }
    if (item.kind === 'question' && !item.answers && !item.dismissed) {
      return { kind: 'question', item }
    }
  }
  return null
}

/** The reply of the latest turn: every assistant message since the last user message. */
export function lastReply(view: SessionView): string {
  const parts: string[] = []
  for (let i = view.items.length - 1; i >= 0; i--) {
    const item = view.items[i]!
    if (item.kind === 'message') {
      if (item.role === 'user') break
      parts.unshift(item.text)
    }
  }
  return parts.join('\n\n').trim()
}

/** The newest finished turn's changes that are still in place, for `undo`. */
export function undoableChanges(view: SessionView) {
  for (let i = view.items.length - 1; i >= 0; i--) {
    const item = view.items[i]!
    if (item.kind === 'changes') return item.reverted ? null : item
  }
  return null
}
