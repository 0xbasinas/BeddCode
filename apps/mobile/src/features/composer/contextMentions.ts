import type { CiReport, GitStatus, PullRequest, RpcResult } from '@beddcode/contracts'

export type ContextMentionId = 'diff' | 'ci' | 'pr' | 'term'

export interface ContextMentionKind {
  id: ContextMentionId
  label: string
  hint: string
  query: string
}

export const CONTEXT_MENTIONS: ContextMentionKind[] = [
  { id: 'diff', label: '@diff', hint: 'Working tree changes', query: 'diff' },
  { id: 'ci', label: '@ci', hint: 'Latest checks', query: 'ci' },
  { id: 'pr', label: '@pr', hint: 'This branch pull request', query: 'pr' },
  { id: 'term', label: '@term', hint: 'Recent terminal output', query: 'term' },
]

/** Special @mentions whose names start with what the user has typed so far (no slash in the query). */
export function matchingContextMentions(query: string): ContextMentionKind[] {
  if (query.includes('/')) return []
  const q = query.toLowerCase()
  return CONTEXT_MENTIONS.filter((m) => m.query.startsWith(q))
}

export function formatDiffMention(status: GitStatus, max = 40): string {
  if (status.files.length === 0) return 'Working tree: no local changes.'
  const rows = status.files.slice(0, max).map((f) => {
    const mark =
      f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : f.status === 'R' ? 'renamed' : 'modified'
    return `- ${mark} ${f.path} (+${f.added}, -${f.removed}${f.staged ? ', staged' : ''})`
  })
  const extra = status.files.length > max ? `\n- …and ${status.files.length - max} more` : ''
  const branch = status.branch ? ` on ${status.branch}` : ''
  return `Working tree${branch} (${status.files.length} file${status.files.length === 1 ? '' : 's'}):\n${rows.join('\n')}${extra}`
}

export function formatCiMention(report: CiReport): string {
  const branch = report.branch ? ` on ${report.branch}` : ''
  if (report.runs.length === 0 && report.failures.length === 0) {
    return `No CI runs were reported${branch}.`
  }
  const lines = report.runs.slice(0, 12).map((run) => {
    const result = run.conclusion || run.status
    return `- ${run.workflow}: ${run.title} (${result})`
  })
  const fails = report.failures
    .slice(0, 6)
    .map((f) => `- failed: ${f.checks.join(', ') || f.workflow || 'check'}`)
  return `CI report${branch}:\n${[...lines, ...fails].join('\n')}`
}

export function formatPrMention(pr: PullRequest | null | undefined): string {
  if (!pr) return 'This branch has no pull request yet.'
  const failed = pr.checks.filter((c) => c.state === 'failure').length
  const pending = pr.checks.filter((c) => c.state === 'pending').length
  const checkBit =
    failed > 0
      ? `, ${failed} checks failing`
      : pending > 0
        ? `, ${pending} checks pending`
        : pr.checks.length
          ? ', checks ok'
          : ''
  return `Pull request #${pr.number} (${pr.state.toLowerCase()}${checkBit}): ${pr.title}\n${pr.url}`
}

export function formatTermMention(tail: RpcResult<'terminals.tail'>): string {
  const label = tail.name || tail.title || tail.shell
  const exit =
    tail.exited === undefined
      ? 'still running'
      : tail.exited === 0
        ? 'exited 0'
        : `failed (exit ${tail.exited})`
  const body = tail.text.trim() || '(no recent output)'
  return `Terminal ${label} — ${exit}:\n${body}`
}

/** The prompt used by "Debug this" on an error or a failed command. */
export function debugThisPrompt(kind: 'error' | 'command' | 'ci', detail: string): string {
  if (kind === 'command') {
    return `A command in the terminal failed. Please diagnose it and suggest a fix.\n\n${detail}`
  }
  if (kind === 'ci') {
    return `CI failed on this branch. Please diagnose the failing checks and suggest a fix.\n\n${detail}`
  }
  return `This error just happened. Please diagnose it and suggest a fix.\n\n${detail}`
}
