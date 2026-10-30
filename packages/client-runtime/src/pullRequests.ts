import type {
  GitCommit,
  GithubStatus,
  PrCleanupResult,
  PrFilter,
  PullRequest,
  PullRequestDetail,
  PullRequestSummary,
} from '@beddcode/contracts'

export const PR_FILTERS: { id: PrFilter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'mine', label: 'Mine' },
  { id: 'review', label: 'Review requested' },
  { id: 'closed', label: 'Closed' },
]

export type PrStateKind = 'open' | 'draft' | 'merged' | 'closed'

/** Open, draft, merged or closed, the way GitHub colours it. */
export function prStateKind(pr: Pick<PullRequest, 'state' | 'isDraft'>): PrStateKind {
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  return pr.isDraft ? 'draft' : 'open'
}

export const PR_STATE_LABEL: Record<PrStateKind, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
}

/** "Approved", "Changes requested", "Review required", or nothing. */
export function reviewLabel(decision: string | undefined): string | undefined {
  switch (decision) {
    case 'APPROVED':
      return 'Approved'
    case 'CHANGES_REQUESTED':
      return 'Changes requested'
    case 'REVIEW_REQUIRED':
      return 'Review required'
    default:
      return undefined
  }
}

/** A review's verdict in words, for the timeline. */
export function reviewStateLabel(state: string | undefined): string {
  switch (state) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'requested changes'
    case 'DISMISSED':
      return 'review dismissed'
    case 'PENDING':
      return 'review pending'
    default:
      return 'reviewed'
  }
}

/** "3 of 4 checks passed", "1 failing", "2 running", for a list row's tooltip. */
export function checksLabel(pr: Pick<PullRequestSummary, 'checks' | 'checkCounts'>): string {
  const c = pr.checkCounts
  if (!c || !pr.checks) return 'No checks'
  if (c.failed) return `${c.failed} of ${c.total} checks failing`
  if (c.pending) return `${c.pending} of ${c.total} checks running`
  return `${c.passed} of ${c.total} checks passed`
}

/** Counts of a full pull request's checks, the way list rows carry them. */
export function checkCounts(checks: PullRequest['checks']) {
  const total = checks.length
  const passed = checks.filter((c) => c.state === 'success').length
  const failed = checks.filter((c) => c.state === 'failure').length
  const pending = checks.filter((c) => c.state === 'pending').length
  return { total, passed, failed, pending }
}

/** A full pull request's checks summed up the way list rows carry them (for `checksLabel`). */
export function checksSummary(
  checks: PullRequest['checks'],
): Pick<PullRequestSummary, 'checks' | 'checkCounts'> {
  const counts = checkCounts(checks)
  if (!counts.total) return {}
  return {
    checks: counts.failed
      ? 'failure'
      : counts.pending
        ? 'pending'
        : counts.passed
          ? 'success'
          : 'skipped',
    checkCounts: counts,
  }
}

/**
 * Why a pull request cannot be merged right now, in a sentence, or undefined when GitHub says
 * it can (or does not say). Merging still asks GitHub, which has the final word.
 */
export function mergeBlocker(pr: PullRequestDetail): string | undefined {
  if (pr.state !== 'OPEN') return `It is ${pr.state === 'MERGED' ? 'already merged' : 'closed'}`
  if (pr.isDraft) return 'It is a draft: mark it ready for review first'
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY')
    return 'It has conflicts with the base branch'
  switch (pr.mergeState) {
    case 'BLOCKED':
      return 'GitHub blocks it until required reviews or checks pass'
    case 'BEHIND':
      return 'Its branch is behind the base branch'
    default:
      return undefined
  }
}

/** A gentler note beside the merge button, when merging is allowed but not quite clean. */
export function mergeWarning(pr: PullRequestDetail): string | undefined {
  if (mergeBlocker(pr)) return undefined
  if (pr.checks.some((c) => c.state === 'failure')) return 'Some checks failed'
  if (pr.checks.some((c) => c.state === 'pending')) return 'Some checks are still running'
  if (pr.mergeState === 'UNSTABLE') return 'Some checks are not passing'
  if (pr.mergeState === 'UNKNOWN' || pr.mergeable === 'UNKNOWN')
    return 'GitHub is still working out whether it can merge'
  return undefined
}

/** What is true of the folder the pull request's branch is checked out in. */
export interface MergeLocalState {
  /** Commits on the branch that are not pushed, so they would not be merged. */
  unpushed: number
  /** Files changed here and not committed, which are not in the pull request. */
  uncommitted: number
}

export interface ReadinessItem {
  level: 'ok' | 'warn' | 'bad'
  text: string
  /** What the user can do about it from here. */
  fix?: 'push' | 'agent'
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Everything worth knowing before merging, in the order to read it: what GitHub says (draft,
 * conflicts, branch behind, required reviews and checks, the reviews themselves), then what only
 * this folder knows (commits not pushed, files not committed), which a merge would leave behind.
 */
export function mergeReadiness(pr: PullRequestDetail, local?: MergeLocalState): ReadinessItem[] {
  if (pr.state !== 'OPEN') return []
  const items: ReadinessItem[] = []
  const blocker = mergeBlocker(pr)
  const needsSync =
    pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY' || pr.mergeState === 'BEHIND'
  if (blocker)
    items.push({ level: 'bad', text: blocker, ...(needsSync ? { fix: 'agent' as const } : {}) })
  else if (pr.mergeState === 'CLEAN' || pr.mergeState === 'HAS_HOOKS')
    items.push({ level: 'ok', text: `No conflicts, up to date with ${pr.baseBranch}` })

  const failed = pr.checks.filter((c) => c.state === 'failure').length
  const pending = pr.checks.filter((c) => c.state === 'pending').length
  const passed = pr.checks.filter((c) => c.state === 'success').length
  if (failed > 0) items.push({ level: 'bad', text: `${plural(failed, 'check', 'checks')} failing` })
  else if (pending > 0)
    items.push({ level: 'warn', text: `${plural(pending, 'check', 'checks')} still running` })
  else if (passed > 0) items.push({ level: 'ok', text: `All ${passed} checks passed` })

  switch (pr.reviewDecision) {
    case 'CHANGES_REQUESTED':
      items.push({ level: 'bad', text: 'A reviewer requested changes' })
      break
    case 'REVIEW_REQUIRED':
      items.push({ level: 'warn', text: 'A review is required' })
      break
    case 'APPROVED':
      items.push({ level: 'ok', text: 'Approved' })
      break
  }
  if (!blocker && failed === 0 && pending === 0 && pr.mergeState === 'UNKNOWN')
    items.push({ level: 'warn', text: 'GitHub is still working out whether it can merge' })

  if (local && local.unpushed > 0)
    items.push({
      level: 'warn',
      text: `${plural(local.unpushed, 'local commit is', 'local commits are')} not pushed, so ${
        local.unpushed === 1 ? 'it' : 'they'
      } will not be merged`,
      fix: 'push',
    })
  if (local && local.uncommitted > 0)
    items.push({
      level: 'warn',
      text: `${plural(local.uncommitted, 'file has', 'files have')} uncommitted changes here that are not in the pull request`,
    })
  return items
}

/** One short line per cleanup step: what was done, and why anything was left alone. */
export function cleanupLines(steps: PrCleanupResult['steps']): string[] {
  const noun = {
    'update-base': 'updating the base branch',
    'remove-worktree': 'removing the worktree',
    'delete-branch': 'deleting the branch',
  } as const
  return steps.map((s) => {
    if (s.status === 'done') {
      if (s.step === 'update-base') return s.detail ?? 'Base branch is up to date'
      return s.step === 'remove-worktree'
        ? 'Removed the worktree'
        : `Deleted ${s.detail ?? 'the branch'}`
    }
    const prefix = s.status === 'failed' ? 'Could not do' : 'Skipped'
    return `${prefix} ${noun[s.step]}${s.detail ? `: ${s.detail}` : ''}`
  })
}

/** The message that asks an agent to bring a branch up to date with its base and fix any conflicts. */
export function syncPrompt(
  pr: Pick<PullRequestDetail, 'number' | 'baseBranch' | 'headBranch' | 'mergeable' | 'mergeState'>,
): string {
  const conflicting = pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY'
  return [
    `Pull request #${pr.number} (${pr.headBranch}) ${
      conflicting ? `has conflicts with ${pr.baseBranch}` : `is behind ${pr.baseBranch}`
    }. Bring this branch up to date:`,
    `1. git fetch origin, then merge origin/${pr.baseBranch} into ${pr.headBranch} (no rebase, no force push).`,
    '2. Resolve any conflicts, keeping the intent of both sides.',
    '3. Run the project checks and fix what the merge broke.',
    '4. Commit the merge and push the branch.',
  ].join('\n')
}

export const MERGE_METHOD_LABEL = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
} as const

/**
 * A first title and description for a new pull request from the branch's commits (newest
 * first, as the log gives them): one commit lends its subject; several become a list.
 */
export function prDraftFromCommits(
  commits: Pick<GitCommit, 'subject'>[],
  branch?: string,
): { title: string; body: string } {
  const oldestFirst = [...commits].reverse()
  if (oldestFirst.length === 0) return { title: branch ? titleFromBranch(branch) : '', body: '' }
  if (oldestFirst.length === 1) return { title: oldestFirst[0]!.subject, body: '' }
  return {
    title: branch ? titleFromBranch(branch) : oldestFirst[0]!.subject,
    body: oldestFirst.map((c) => `- ${c.subject}`).join('\n'),
  }
}

/** `feat/alerts-and-schedules` → "Alerts and schedules". */
export function titleFromBranch(branch: string): string {
  const last = branch.split('/').filter(Boolean).at(-1) ?? branch
  const words = last.replace(/[-_]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : branch
}

/** What to tell the user when the host's gh cannot be used, with the command that fixes it. */
export function githubProblem(
  status: GithubStatus | undefined,
): { title: string; detail: string; command?: string; link?: string } | undefined {
  switch (status?.state) {
    case 'not-installed':
      return {
        title: 'The GitHub CLI is not installed on this host',
        detail:
          'Install gh on the computer running BeddCode, then sign in once. Pull requests go through it; BeddCode never sees your token.',
        command: 'gh auth login',
        link: 'https://cli.github.com',
      }
    case 'signed-out':
      return {
        title: 'Sign in to GitHub on this host',
        detail:
          'Run this once in a terminal on the computer running BeddCode, then refresh. BeddCode never sees your token.',
        command: 'gh auth login',
      }
    case 'no-repo':
      return {
        title: 'This folder is not on GitHub',
        detail: 'It has no remote that points at GitHub. Add one, or push it with gh:',
        command: 'gh repo create --source . --push',
      }
    case 'error':
      return { title: 'GitHub is unavailable', detail: status.message }
    default:
      return undefined
  }
}

/**
 * A comment body ready for the Markdown view, which does not render raw HTML: bot tables and
 * hidden markers would otherwise show up as tag soup.
 */
export function commentText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<\/?(?:table|thead|tbody|tr|td|th|div|span|img|br|p|sub|sup|details|summary|a|b|i|strong|em|code|kbd|picture|source|h\d)\b[^>]*>/gi,
      ' ',
    )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
