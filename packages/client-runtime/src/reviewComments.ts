// Review-comment model adapted from Paseo's diff review drafts and review attachments
// (https://github.com/getpaseo/paseo: packages/app/src/review/state.ts,
// packages/app/src/review/feedback/index.ts, packages/server/src/server/agent/prompt-attachments.ts).
// Licensed under the Apache License, Version 2.0; Copyright Mohamed Boudra and Paseo contributors.
// See THIRD_PARTY_NOTICES.md. Modified for BeddCode: comments are taken on BeddCode's unified-diff
// text, the context is captured when the comment is made, and the review is rendered as Markdown
// that any agent (Claude, Codex, ACP) reads as plain text.

export type PatchLineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta'

export interface PatchLine {
  kind: PatchLineKind
  /** The line's text without its leading +, - or space. */
  text: string
  /** Line number in the old file (removed and unchanged lines). */
  oldLine?: number
  /** Line number in the new file (added and unchanged lines). */
  newLine?: number
  /** The `@@ … @@` header of the hunk this line belongs to. */
  hunk?: string
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Splits a unified diff into lines numbered on both sides. */
export function numberPatch(patch: string): PatchLine[] {
  const out: PatchLine[] = []
  let oldLine = 0
  let newLine = 0
  let hunk: string | undefined
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const header = HUNK.exec(raw)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      hunk = raw
      inHunk = true
      out.push({ kind: 'hunk', text: raw })
      continue
    }
    if (!inHunk || /^(diff |index |--- |\+\+\+ )/.test(raw)) {
      inHunk = inHunk && !raw.startsWith('diff ')
      out.push({ kind: 'meta', text: raw })
      continue
    }
    if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), newLine: newLine++, hunk })
    else if (raw.startsWith('-'))
      out.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++, hunk })
    else if (raw.startsWith(' ') || (raw === '' && inHunk))
      out.push({
        kind: 'context',
        text: raw.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
        hunk,
      })
    else out.push({ kind: 'meta', text: raw }) // "\ No newline at end of file"
  }
  // A trailing newline in the patch leaves one empty "context" line that is not in the file.
  const last = out.at(-1)
  if (last && last.kind === 'context' && last.text === '' && patch.endsWith('\n')) out.pop()
  return out
}

export type ReviewSide = 'old' | 'new'

export interface ReviewComment {
  id: string
  /** Repository-relative path of the file. */
  path: string
  /** Removed lines are commented on the old side, everything else on the new side. */
  side: ReviewSide
  line: number
  body: string
  /** The diff around the line when the comment was made, so the agent sees what was meant. */
  context: { hunk: string; lines: PatchLine[]; target: number }
  createdAt: number
}

/** Lines shown before and after the commented one. */
export const REVIEW_CONTEXT_RADIUS = 3

/** Which side and number a commentable line has; null for headers. */
export function commentAnchor(line: PatchLine): { side: ReviewSide; line: number } | null {
  if (line.kind === 'del' && line.oldLine !== undefined) return { side: 'old', line: line.oldLine }
  if ((line.kind === 'add' || line.kind === 'context') && line.newLine !== undefined)
    return { side: 'new', line: line.newLine }
  return null
}

/** A new comment on line `index` of a numbered patch, with the surrounding lines of its hunk. */
export function createReviewComment(input: {
  path: string
  lines: PatchLine[]
  index: number
  body: string
  id?: string
  now?: number
}): ReviewComment | null {
  const target = input.lines[input.index]
  const anchor = target && commentAnchor(target)
  const body = input.body.trim()
  if (!target || !anchor || !body) return null
  let start = input.index
  let end = input.index
  const sameHunk = (i: number) => {
    const l = input.lines[i]
    return l !== undefined && l.hunk === target.hunk && l.kind !== 'hunk' && l.kind !== 'meta'
  }
  while (start > input.index - REVIEW_CONTEXT_RADIUS && sameHunk(start - 1)) start -= 1
  while (end < input.index + REVIEW_CONTEXT_RADIUS && sameHunk(end + 1)) end += 1
  return {
    id: input.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    path: input.path,
    side: anchor.side,
    line: anchor.line,
    body,
    context: {
      hunk: target.hunk ?? '',
      lines: input.lines.slice(start, end + 1),
      target: input.index - start,
    },
    createdAt: input.now ?? Date.now(),
  }
}

/** Comments in reading order: by file, then by line. */
export function sortReviewComments(comments: readonly ReviewComment[]): ReviewComment[] {
  return [...comments].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1) ||
      a.createdAt - b.createdAt,
  )
}

const pad = (n: number | undefined) => (n === undefined ? '' : String(n)).padStart(4)
const MARK: Record<PatchLineKind, string> = {
  add: '+',
  del: '-',
  context: ' ',
  hunk: ' ',
  meta: ' ',
}

/** The comments as one message an agent can act on: what to change, where, and the diff around it. */
export function formatReview(input: { cwd: string; comments: readonly ReviewComment[] }): string {
  const comments = sortReviewComments(input.comments)
  const out = [
    `Review comments on the uncommitted changes in \`${input.cwd}\` (${comments.length}).`,
    'Please address each one. Lines marked `>` are the ones commented on.',
  ]
  comments.forEach((c, i) => {
    out.push(
      '',
      `### ${i + 1}. \`${c.path}\` line ${c.line}${c.side === 'old' ? ' (removed line)' : ''}`,
      '',
      c.body,
      '',
    )
    out.push('```diff')
    if (c.context.hunk) out.push(c.context.hunk)
    c.context.lines.forEach((l, j) => {
      out.push(
        `${j === c.context.target ? '>' : ' '}${pad(l.oldLine)} ${pad(l.newLine)} ${MARK[l.kind]}${l.text}`,
      )
    })
    out.push('```')
  })
  return out.join('\n')
}

/** What is left after sending: only the comments that went out are removed, new ones stay. */
export function withoutSent(
  all: readonly ReviewComment[],
  sent: readonly ReviewComment[],
): ReviewComment[] {
  const ids = new Set(sent.map((c) => c.id))
  return all.filter((c) => !ids.has(c.id))
}
