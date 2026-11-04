import type { SessionView } from './replica.ts'

const compact = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A file the working tree changed; `patch` is only mined for its counts and first hunk header. */
export type HandoffFile = {
  path: string
  status?: string
  patch?: string
  added?: number
  removed?: number
}

export type HandoffOptions = {
  /** The agent being left (named in the reason). */
  agentLabel?: string
  /** The agent receiving the note. */
  targetLabel?: string
  /** Why the switch happens; defaults to a manual switch. */
  reason?: string
  maxChars?: number
  pendingMessage?: string
  /** The working tree's changes, summarized per file. */
  files?: HandoffFile[]
  /** Only what happened since the receiving agent last worked on the session. */
  delta?: boolean
}

type Section = {
  title: string
  lines: string[]
  trimmed?: boolean
}

type FileSummary = { path: string; counts?: string; hunk?: string }

const TURN_TEXT = { user: 200, agent: 300 }
const MAX_TURN_LINES = 12
const MAX_FILES = 30
const MAX_DECISIONS = 5

const countPatch = (patch: string) => {
  let added = 0
  let removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

const DECISION = /^(?:[-*]\s*)?(?:decision|decided|chose|chosen|going with|we(?:'ll| will) use)\b/i

/**
 * A structured note that lets another agent pick up a session's work. It is made of labelled
 * sections (reason, goal, plan, decisions, changed files, recent turns, pending message); empty
 * sections are left out. When it is over `maxChars`, older turns go first, then diff detail, then
 * decisions, then the plan and file list. The reason, goal and pending message are never dropped.
 */
export function handoffPrompt(view: SessionView, options: HandoffOptions = {}): string {
  const maxChars = options.maxChars ?? 6_000
  const delta = !!options.delta

  const turns: string[] = []
  const decisions: string[] = []
  const touched = new Set<string>()
  const itemCounts = new Map<string, { added: number; removed: number }>()
  const original = view.items.find((item) => item.kind === 'message' && item.role === 'user')
  for (const item of view.items) {
    switch (item.kind) {
      case 'message': {
        if (!item.text.trim()) break
        turns.push(
          item.role === 'user'
            ? `You asked: ${compact(item.text, TURN_TEXT.user)}`
            : `Agent: ${compact(item.text, TURN_TEXT.agent)}`,
        )
        if (item.role !== 'user')
          for (const line of item.text.split('\n'))
            if (DECISION.test(line.trim()))
              decisions.push(compact(line.replace(/^[-*]\s*/, ''), 160))
        break
      }
      case 'tool':
        if (item.toolKind === 'command') turns.push(`Ran: ${compact(item.title, 120)}`)
        for (const p of item.toolKind === 'edit' ? (item.paths ?? []) : []) touched.add(p)
        break
      case 'diff':
        touched.add(item.path)
        itemCounts.set(item.path, { added: item.added, removed: item.removed })
        break
      case 'changes':
        if (item.reverted) turns.push('Undid the changes of that turn.')
        else for (const f of item.files) touched.add(f.path)
        break
      case 'error':
        turns.push(`Error: ${compact(item.message, 160)}`)
        break
      default:
        break
    }
  }

  // Working-tree files win (they have the real patch). In a delta, only files touched since then.
  const files = new Map<string, FileSummary>()
  const summarize = (file: HandoffFile): FileSummary => {
    const counts = file.patch ? countPatch(file.patch) : undefined
    const added = file.added ?? counts?.added
    const removed = file.removed ?? counts?.removed
    return {
      path: file.path,
      counts:
        added === undefined && removed === undefined
          ? undefined
          : `+${added ?? 0}/-${removed ?? 0}`,
      hunk: file.patch
        ?.split('\n')
        .find((line) => line.startsWith('@@'))
        ?.trim(),
    }
  }
  // Agents report absolute paths and git reports relative ones; one file gets one line.
  const relative = (path: string) => {
    const root = view.cwd.replace(/\/+$/, '')
    const stripped = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
    return stripped.replace(/^\.\//, '')
  }
  const put = (summary: FileSummary) => {
    const known = files.get(summary.path)
    files.set(
      summary.path,
      known
        ? {
            path: summary.path,
            counts: summary.counts ?? known.counts,
            hunk: summary.hunk ?? known.hunk,
          }
        : summary,
    )
  }
  const touchedRelative = new Set([...touched].map(relative))
  for (const path of touched) {
    const counts = itemCounts.get(path)
    put({ ...summarize({ path: relative(path), ...counts }) })
  }
  for (const file of options.files ?? []) {
    const path = relative(file.path)
    if (delta && !touchedRelative.has(path)) continue
    put(summarize({ ...file, path }))
  }
  const fileList = [...files.values()]

  const sections: (Section & { key: string })[] = []
  const add = (key: string, title: string, lines: string[]) => {
    if (lines.length > 0) sections.push({ key, title, lines })
  }

  const from = options.agentLabel ?? 'another agent'
  const reason = compact(
    options.reason ??
      (delta
        ? `The user switched back to you from ${from}.`
        : `The user switched this session from ${from}${options.targetLabel ? ` to ${options.targetLabel}` : ''}.`),
    300,
  )
  const where = [
    view.projectless ? undefined : `Folder: ${view.cwd}`,
    view.branch ? `Branch: ${view.branch}` : undefined,
  ].filter((line): line is string => !!line)
  add('reason', 'Reason for the switch', [
    reason,
    delta
      ? 'You worked on this session earlier; the notes below are only what changed since then.'
      : 'Check the current state of the files before changing anything.',
  ])
  if (!delta)
    add('goal', 'Goal', [
      compact(original?.kind === 'message' ? original.text : view.title, 500),
      ...where,
    ])
  else if (where.length) sections[0]!.lines.push(...where)
  if (view.plan?.steps.length)
    add('plan', 'Plan', [
      ...(view.plan.explanation ? [compact(view.plan.explanation, 200)] : []),
      ...view.plan.steps.map((s) => `[${s.status}] ${compact(s.text, 140)}`),
    ])
  add('decisions', 'Decisions', [...new Set(decisions)].slice(-MAX_DECISIONS))
  // Lines are filled in by renderFiles, which the trimming below re-runs.
  add(
    'files',
    delta ? 'Files changed since you last worked' : 'Changed files',
    fileList.length ? [''] : [],
  )
  add('turns', delta ? 'What happened meanwhile' : 'Recent turns', turns.slice(-MAX_TURN_LINES))
  const fileSection = sections.find((s) => s.key === 'files')
  let shown = fileList.slice(0, MAX_FILES)
  let showHunks = true
  const renderFiles = () => {
    if (!fileSection) return
    fileSection.lines = shown.map(
      (f) =>
        `${f.path}${f.counts ? ` (${f.counts})` : ''}${showHunks && f.hunk ? ` ${f.hunk}` : ''}`,
    )
    if (fileList.length > shown.length)
      fileSection.lines.push(`and ${fileList.length - shown.length} more`)
  }
  renderFiles()
  const pendingText = options.pendingMessage?.trim()
  if (pendingText)
    add('pending', 'Pending message', [
      compact(pendingText, Math.max(1, Math.min(1_000, Math.floor(maxChars / 4)))),
    ])

  const render = () =>
    sections
      .map((s) =>
        `## ${s.title}${s.trimmed ? ' (trimmed)' : ''}\n${s.lines.map((l) => (s.key === 'reason' || s.key === 'goal' || s.key === 'pending' ? l : `- ${l}`)).join('\n')}`.trimEnd(),
      )
      .join('\n\n')
  const heading = delta ? 'Handoff update' : 'Handoff note'
  const note = () => `# ${heading}\n\n${render()}\n`

  // Trim in priority order until it fits. Reason, goal and pending message are never touched.
  const section = (key: string) => sections.find((s) => s.key === key)
  const shrink = (key: string) => {
    const s = section(key)
    if (!s || s.lines.length === 0) return false
    s.lines.shift()
    s.trimmed = true
    return true
  }
  while (note().length > maxChars) {
    if (shrink('turns')) continue
    if (showHunks && fileSection) {
      showHunks = false
      fileSection.trimmed = true
      renderFiles()
      continue
    }
    if (shrink('decisions')) continue
    if (shrink('plan')) continue
    if (fileSection && shown.length > 0) {
      shown = shown.slice(0, shown.length - 1)
      fileSection.trimmed = true
      renderFiles()
      if (shown.length === 0) fileSection.lines = []
      continue
    }
    break
  }
  // The fixed sections can themselves be over a tiny budget; that is a hard cap.
  return note().slice(0, Math.max(0, maxChars))
}

/** The parts of a note for display: an optional intro, then each `## Title` with its text. */
export function parseHandoffNote(note: string): { title?: string; body: string }[] {
  const parts: { title?: string; body: string }[] = []
  note.split(/^## /m).forEach((chunk, index) => {
    if (index === 0 && !note.startsWith('## ')) {
      const intro = chunk.replace(/^# .*\n?/, '').trim()
      if (intro) parts.push({ body: intro })
      return
    }
    const newline = chunk.indexOf('\n')
    const title = (newline < 0 ? chunk : chunk.slice(0, newline)).trim()
    const body = newline < 0 ? '' : chunk.slice(newline + 1).trim()
    parts.push({ title, body })
  })
  return parts
}
