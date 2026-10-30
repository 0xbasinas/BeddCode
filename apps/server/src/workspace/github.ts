import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  CiReport,
  GithubStatus,
  PrAction,
  PrCheckState,
  PrFilter,
  PullRequest,
  PullRequestDetail,
  PullRequestSummary,
} from '@beddcode/contracts'
import { runCommand } from '@beddcode/shared'
import type { GitService, Runner } from './git.ts'

export class GithubError extends Error {}

// No prompts, no pager, no colour: gh runs headless for us. Its token stays with gh.
const defaultRunner: Runner = (file, args, { cwd, timeoutMs }) =>
  runCommand(file, args, {
    cwd,
    timeoutMs: timeoutMs ?? 30_000,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: '1',
      NO_COLOR: '1',
      GH_PAGER: '',
      GIT_TERMINAL_PROMPT: '0',
    },
  })

/** How to find a session's pull request when its folder cannot say: the branch it was on, in this repository. */
export interface PrLookup {
  branch?: string
  repo?: string
}

const PR_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'body',
  'headRefName',
  'baseRefName',
  'createdAt',
  'statusCheckRollup',
  'reviewDecision',
  'files',
].join(',')

const LIST_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'author',
  'headRefName',
  'baseRefName',
  'updatedAt',
  'statusCheckRollup',
  'reviewDecision',
  'additions',
  'deletions',
  'isCrossRepository',
].join(',')

const VIEW_FIELDS = [
  PR_FIELDS,
  'author',
  'updatedAt',
  'closedAt',
  'mergedAt',
  'mergedBy',
  'headRefOid',
  'isCrossRepository',
  'mergeable',
  'mergeStateStatus',
  'additions',
  'deletions',
  'reviews',
  'comments',
].join(',')

const REPO_FIELDS = [
  'nameWithOwner',
  'url',
  'defaultBranchRef',
  'viewerPermission',
  'mergeCommitAllowed',
  'squashMergeAllowed',
  'rebaseMergeAllowed',
  'deleteBranchOnMerge',
].join(',')

type Check = {
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
  workflowName?: string
}

type Login = { login?: string } | null | undefined

type RawPr = {
  number: number
  title: string
  url: string
  state: PullRequest['state']
  isDraft: boolean
  body?: string
  headRefName: string
  baseRefName: string
  createdAt?: string
  updatedAt?: string
  closedAt?: string
  mergedAt?: string
  mergedBy?: Login
  author?: Login
  statusCheckRollup?: Check[]
  reviewDecision?: string
  files?: { path: string; additions: number; deletions: number }[]
  additions?: number
  deletions?: number
  isCrossRepository?: boolean
  headRefOid?: string
  mergeable?: string
  mergeStateStatus?: string
  reviews?: { author?: Login; body?: string; state?: string; submittedAt?: string }[]
  comments?: { author?: Login; body?: string; createdAt?: string; url?: string }[]
}

export function checkState(check: Check): PrCheckState {
  // Check runs carry status + conclusion; legacy commit statuses carry only a state.
  const raw = (check.conclusion || check.state || check.status || '').toUpperCase()
  if (['SUCCESS'].includes(raw)) return 'success'
  if (
    ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(
      raw,
    )
  ) {
    return 'failure'
  }
  if (['NEUTRAL', 'SKIPPED', 'STALE'].includes(raw)) return 'skipped'
  return 'pending'
}

/** The checks of a pull request in one word: any failure wins, then anything still running. */
export function rollup(checks: Check[] | undefined) {
  if (!checks?.length) return {}
  const states = checks.map(checkState)
  const count = (s: PrCheckState) => states.filter((x) => x === s).length
  const failed = count('failure')
  const pending = count('pending')
  const passed = count('success')
  return {
    checks: (failed
      ? 'failure'
      : pending
        ? 'pending'
        : passed
          ? 'success'
          : 'skipped') as PrCheckState,
    checkCounts: { total: states.length, passed, failed, pending },
  }
}

const time = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : undefined
}
const who = (l: Login) => l?.login || 'ghost'

/** How long a folder's pull request answer is reused before gh is asked again. */
const PR_CACHE_MS = 20_000
/** At most this many failing runs have their logs read, and each log keeps its last stretch. */
const MAX_CI_LOGS = 3
const CI_LOG_CHARS = 8_000

interface RawRun {
  databaseId: number
  workflowName: string
  displayTitle: string
  status: string
  conclusion?: string
  headSha?: string
  createdAt?: string
  url: string
}

/** A failed-steps log without colour codes and the timestamp that starts every line. */
function cleanLog(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, ''))
    .join('\n')
    .trim()
}

const AUTH_RE = /gh auth login|not logged in|authentication|auth token|HTTP 401|bad credentials/i
const NO_REPO_RE =
  /none of the git remotes|not a github|no github remote|not a git repository|no git remotes/i

/** Pull requests through the user's own signed-in GitHub CLI; we never hold or log a token. */
export class GithubService {
  private readonly statusCache = new Map<string, { at: number; value: GithubStatus }>()
  /** The branch's pull request per folder: every session row asks, so answers are shared briefly. */
  private readonly prCache = new Map<
    string,
    { at: number; pending?: Promise<PullRequest | null>; value?: PullRequest | null }
  >()

  constructor(private readonly run: Runner = defaultRunner) {}

  private async gh(cwd: string, args: string[], timeoutMs?: number) {
    try {
      return await this.run('gh', args, { cwd, timeoutMs })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new GithubError('The GitHub CLI (gh) is not installed on this host')
      }
      throw err
    }
  }

  private fail(stderr: string): never {
    const text = stderr.trim()
    if (NO_REPO_RE.test(text)) throw new GithubError('This repository has no GitHub remote')
    if (/multiple remotes|set-default|gh repo set-default/i.test(text)) {
      throw new GithubError(
        'This folder has several remotes: pick its GitHub repo with `gh repo set-default`',
      )
    }
    if (AUTH_RE.test(text)) {
      throw new GithubError('Sign in to GitHub on this host first: run `gh auth login`')
    }
    throw new GithubError(text.split('\n').slice(0, 6).join('\n') || 'The GitHub CLI failed')
  }

  /** Runs gh and gives back stdout, or throws a readable error. */
  private async ok(cwd: string, args: string[], timeoutMs?: number) {
    const res = await this.gh(cwd, args, timeoutMs)
    if (res.code !== 0) this.fail(res.stderr || res.stdout)
    return res.stdout
  }

  /** Writes text to a private temp file for `--body-file`, so no body rides the command line. */
  private async withBodyFile<T>(text: string, use: (file: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-gh-'))
    const file = path.join(dir, 'body.md')
    writeFileSync(file, text, { mode: 0o600 })
    try {
      return await use(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Is gh installed and signed in, and which GitHub repo is this folder? */
  async status(cwd: string, fresh = false): Promise<GithubStatus> {
    const cached = this.statusCache.get(cwd)
    if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.value
    const value = await this.readStatus(cwd)
    if (value.state === 'ready') this.statusCache.set(cwd, { at: Date.now(), value })
    else this.statusCache.delete(cwd)
    return value
  }

  private async readStatus(cwd: string): Promise<GithubStatus> {
    let user
    try {
      user = await this.gh(cwd, ['api', 'user', '--jq', '.login'])
    } catch (err) {
      if (err instanceof GithubError) return { state: 'not-installed' }
      return { state: 'error', message: err instanceof Error ? err.message : String(err) }
    }
    if (user.code !== 0) {
      const text = (user.stderr || user.stdout).trim()
      if (AUTH_RE.test(text) || user.code === 4) return { state: 'signed-out' }
      return { state: 'error', message: text.split('\n')[0] || 'The GitHub CLI failed' }
    }
    const login = user.stdout.trim()
    const repo = await this.gh(cwd, ['repo', 'view', '--json', REPO_FIELDS])
    if (repo.code !== 0) {
      const text = (repo.stderr || repo.stdout).trim()
      if (NO_REPO_RE.test(text)) return { state: 'no-repo', login }
      try {
        this.fail(text)
      } catch (err) {
        return { state: 'error', message: (err as Error).message }
      }
    }
    const r = JSON.parse(repo.stdout) as {
      nameWithOwner: string
      url: string
      defaultBranchRef?: { name?: string } | null
      viewerPermission?: string
      mergeCommitAllowed?: boolean
      squashMergeAllowed?: boolean
      rebaseMergeAllowed?: boolean
      deleteBranchOnMerge?: boolean
    }
    const mergeMethods: ('merge' | 'squash' | 'rebase')[] = []
    if (r.squashMergeAllowed) mergeMethods.push('squash')
    if (r.mergeCommitAllowed) mergeMethods.push('merge')
    if (r.rebaseMergeAllowed) mergeMethods.push('rebase')
    return {
      state: 'ready',
      login,
      repo: r.nameWithOwner,
      url: r.url,
      defaultBranch: r.defaultBranchRef?.name || undefined,
      permission: r.viewerPermission || undefined,
      mergeMethods,
      deleteBranchOnMerge: Boolean(r.deleteBranchOnMerge),
    }
  }

  /** The repo's pull requests for one of the list's filters, newest activity first. */
  async list(cwd: string, filter: PrFilter, limit = 30): Promise<PullRequestSummary[]> {
    const args = ['pr', 'list', '--limit', String(limit), '--json', LIST_FIELDS]
    if (filter === 'open') args.push('--state', 'open')
    if (filter === 'mine') args.push('--state', 'open', '--author', '@me')
    if (filter === 'review') args.push('--state', 'open', '--search', 'review-requested:@me')
    if (filter === 'closed') args.push('--state', 'closed')
    const raw = JSON.parse(await this.ok(cwd, args)) as RawPr[]
    return raw
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        isDraft: pr.isDraft,
        author: who(pr.author),
        headBranch: pr.headRefName,
        baseBranch: pr.baseRefName,
        updatedAt: time(pr.updatedAt),
        ...rollup(pr.statusCheckRollup),
        reviewDecision: pr.reviewDecision || undefined,
        added: pr.additions,
        removed: pr.deletions,
        fromFork: pr.isCrossRepository || undefined,
      }))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  private mapChecks(checks: Check[] | undefined): PullRequest['checks'] {
    return (checks ?? []).map((c) => ({
      name: c.name ?? c.context ?? 'check',
      state: checkState(c),
      url: c.detailsUrl || c.targetUrl || undefined,
      workflow: c.workflowName || undefined,
    }))
  }

  private mapPr(pr: RawPr): PullRequest {
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      body: pr.body ?? '',
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      createdAt: time(pr.createdAt),
      checks: this.mapChecks(pr.statusCheckRollup),
      reviewDecision: pr.reviewDecision || undefined,
      files: (pr.files ?? []).map((f) => ({
        path: f.path,
        added: f.additions,
        removed: f.deletions,
      })),
    }
  }

  /** The pull request for the current branch, or null when there is none. */
  async pullRequest(cwd: string, find?: PrLookup): Promise<PullRequest | null> {
    const cacheKey = find?.branch ? `${cwd}::${find.branch}` : cwd
    const cached = this.prCache.get(cacheKey)
    if (cached?.pending) return cached.pending
    if (cached && cached.value !== undefined && Date.now() - cached.at < PR_CACHE_MS) {
      return cached.value
    }
    const pending = this.readPullRequest(cwd, find)
    this.prCache.set(cacheKey, { at: Date.now(), pending })
    try {
      const value = await pending
      this.prCache.set(cacheKey, { at: Date.now(), value })
      return value
    } catch (err) {
      this.prCache.delete(cacheKey)
      throw err
    }
  }

  /**
   * The branch's recent Actions runs, and the failed steps' logs of its pull request's failing
   * checks, so an agent can be told what broke. A run's log is read once however many of its jobs
   * failed.
   */
  async ciReport(cwd: string): Promise<CiReport> {
    const pr = await this.pullRequest(cwd)
    const branch = pr?.headBranch
    const runs: CiReport['runs'] = []
    if (branch) {
      const listed = await this.gh(cwd, [
        'run',
        'list',
        '--branch',
        branch,
        '--limit',
        '8',
        '--json',
        'databaseId,workflowName,displayTitle,status,conclusion,headSha,createdAt,url',
      ])
      if (listed.code === 0) {
        try {
          for (const r of JSON.parse(listed.stdout) as RawRun[])
            runs.push({
              id: r.databaseId,
              workflow: r.workflowName,
              title: r.displayTitle,
              status: r.status,
              conclusion: r.conclusion || undefined,
              sha: r.headSha?.slice(0, 7),
              at: time(r.createdAt),
              url: r.url,
            })
        } catch {
          // A run list we cannot read leaves the logs, which matter more.
        }
      }
    }
    const byRun = new Map<string, CiReport['failures'][number]>()
    for (const check of pr?.checks ?? []) {
      if (check.state !== 'failure') continue
      const runId = /\/runs\/(\d+)/.exec(check.url ?? '')?.[1]
      const key = runId ?? `check:${check.name}`
      const known = byRun.get(key)
      if (known) known.checks.push(check.name)
      else byRun.set(key, { checks: [check.name], workflow: check.workflow, url: check.url })
    }
    const failures = [...byRun.entries()].slice(0, MAX_CI_LOGS)
    await Promise.all(
      failures.map(async ([key, failure]) => {
        if (key.startsWith('check:')) return
        const res = await this.gh(cwd, ['run', 'view', key, '--log-failed'], 60_000).catch(
          () => undefined,
        )
        if (!res || res.code !== 0) return
        const log = cleanLog(res.stdout)
        failure.truncated = log.length > CI_LOG_CHARS || undefined
        failure.log = log.slice(-CI_LOG_CHARS)
      }),
    )
    return {
      pr: pr ? { number: pr.number, title: pr.title, url: pr.url } : null,
      branch,
      runs,
      failures: failures.map(([, f]) => f),
    }
  }

  private async readPullRequest(cwd: string, find?: PrLookup): Promise<PullRequest | null> {
    // A folder that is gone (a removed worktree) cannot be asked what its branch is; the branch
    // name the session kept, looked up from the repository, still finds the pull request.
    const folder = existsSync(cwd) ? cwd : find?.repo && existsSync(find.repo) ? find.repo : cwd
    if (folder === cwd) {
      const res = await this.gh(cwd, ['pr', 'view', '--json', PR_FIELDS])
      if (res.code === 0) return this.mapPr(JSON.parse(res.stdout) as RawPr)
      // With no branch to fall back on, or any other trouble, say so.
      if (
        !find?.branch ||
        !/no pull requests found|could not determine current branch/i.test(res.stderr)
      ) {
        if (/no pull requests found/i.test(res.stderr)) return null
        this.fail(res.stderr)
      }
    }
    if (!find?.branch) return null
    // The branch may be deleted by now (merged, then cleaned up): list by name, any state.
    const listed = JSON.parse(
      await this.ok(folder, [
        'pr',
        'list',
        '--head',
        find.branch,
        '--state',
        'all',
        '--limit',
        '10',
        '--json',
        PR_FIELDS,
      ]),
    ) as RawPr[]
    // Prefer one still open, then the newest.
    const best = listed.sort(
      (a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number,
    )[0]
    return best ? this.mapPr(best) : null
  }

  /** One pull request in full, with its reviews and comments in order. */
  async view(cwd: string, number: number): Promise<PullRequestDetail> {
    const pr = JSON.parse(
      await this.ok(cwd, ['pr', 'view', String(number), '--json', VIEW_FIELDS]),
    ) as RawPr
    const timeline: PullRequestDetail['timeline'] = [
      ...(pr.comments ?? []).map((c) => ({
        kind: 'comment' as const,
        author: who(c.author),
        body: c.body ?? '',
        at: time(c.createdAt),
        url: c.url || undefined,
      })),
      // A review with no words and no verdict (a lone inline comment's shell) says nothing here.
      ...(pr.reviews ?? [])
        .filter((r) => (r.body ?? '').trim() || (r.state && r.state !== 'COMMENTED'))
        .map((r) => ({
          kind: 'review' as const,
          author: who(r.author),
          body: r.body ?? '',
          at: time(r.submittedAt),
          state: r.state || undefined,
        })),
    ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    return {
      ...this.mapPr(pr),
      author: who(pr.author),
      updatedAt: time(pr.updatedAt),
      closedAt: time(pr.closedAt),
      mergedAt: time(pr.mergedAt),
      mergedBy: pr.mergedBy?.login || undefined,
      headOid: pr.headRefOid || undefined,
      fromFork: pr.isCrossRepository || undefined,
      mergeable: pr.mergeable || undefined,
      mergeState: pr.mergeStateStatus || undefined,
      added: pr.additions,
      removed: pr.deletions,
      timeline,
    }
  }

  /** Mark ready, back to draft, close, reopen, comment or merge. */
  async act(cwd: string, number: number, action: PrAction): Promise<{ message?: string }> {
    this.prCache.delete(cwd)
    const n = String(number)
    switch (action.action) {
      case 'ready':
        await this.ok(cwd, ['pr', 'ready', n])
        return { message: 'Marked ready for review' }
      case 'draft':
        await this.ok(cwd, ['pr', 'ready', n, '--undo'])
        return { message: 'Converted to draft' }
      case 'reopen':
        await this.ok(cwd, ['pr', 'reopen', n])
        return { message: 'Reopened' }
      case 'close': {
        const comment = action.comment?.trim()
        if (comment) {
          await this.withBodyFile(comment, (file) =>
            this.ok(cwd, ['pr', 'comment', n, '--body-file', file]),
          )
        }
        await this.ok(cwd, ['pr', 'close', n])
        return { message: 'Closed' }
      }
      case 'comment':
        await this.withBodyFile(action.body, (file) =>
          this.ok(cwd, ['pr', 'comment', n, '--body-file', file]),
        )
        return { message: 'Comment added' }
      case 'merge': {
        let head: { headRefName: string; isCrossRepository?: boolean } | undefined
        if (action.deleteBranch) {
          head = JSON.parse(
            await this.ok(cwd, ['pr', 'view', n, '--json', 'headRefName,isCrossRepository']),
          ) as { headRefName: string; isCrossRepository?: boolean }
        }
        const args = ['pr', 'merge', n, `--${action.method}`]
        if (action.headOid) args.push('--match-head-commit', action.headOid)
        if (action.subject?.trim()) args.push('--subject', action.subject.trim())
        const body = action.body?.trim()
        if (body) {
          await this.withBodyFile(body, (file) =>
            this.ok(cwd, [...args, '--body-file', file], 60_000),
          )
        } else {
          await this.ok(cwd, args, 60_000)
        }
        // Only the branch on GitHub: `gh pr merge --delete-branch` would also switch and delete
        // the local branch, which may be checked out in this folder or a worktree.
        if (head && !head.isCrossRepository && head.headRefName) {
          const res = await this.gh(cwd, [
            'api',
            '--method',
            'DELETE',
            `repos/{owner}/{repo}/git/refs/heads/${encodeURIComponent(head.headRefName).replace(/%2F/g, '/')}`,
          ])
          if (res.code !== 0) {
            return { message: `Merged, but the branch could not be deleted on GitHub` }
          }
          return { message: `Merged and deleted ${head.headRefName} on GitHub` }
        }
        return { message: 'Merged' }
      }
    }
  }

  /**
   * Checks a pull request out. Here: `gh pr checkout` switches this folder's branch. Into a
   * worktree: fetches the PR's head and adds a worktree under `<repo>/.wt/`, on the PR's branch
   * (tracking it, so pushes go back to the PR) or `pr/<n>` for a fork.
   */
  async checkout(
    cwd: string,
    number: number,
    git: GitService,
    options: { worktree?: boolean } = {},
  ): Promise<{ branch: string; path: string }> {
    this.prCache.delete(cwd)
    const n = String(number)
    if (!options.worktree) {
      await this.ok(cwd, ['pr', 'checkout', n], 120_000)
      const info = await git.info(cwd)
      return { branch: info.branch ?? `pr/${n}`, path: info.root ?? cwd }
    }
    const pr = JSON.parse(
      await this.ok(cwd, ['pr', 'view', n, '--json', 'headRefName,isCrossRepository']),
    ) as { headRefName: string; isCrossRepository?: boolean }
    const status = await this.status(cwd)
    const remote = await this.remoteFor(cwd, status.state === 'ready' ? status.repo : undefined)
    const sameRepo = !pr.isCrossRepository && Boolean(pr.headRefName)
    const prRef = `refs/remotes/${remote}/pr/${n}`
    const refspecs = [`+refs/pull/${n}/head:${prRef}`]
    if (sameRepo)
      refspecs.push(`+refs/heads/${pr.headRefName}:refs/remotes/${remote}/${pr.headRefName}`)
    const fetched = await this.run('git', ['fetch', '--no-tags', remote, ...refspecs], {
      cwd,
      timeoutMs: 120_000,
    })
    if (fetched.code !== 0) throw new GithubError(fetched.stderr.trim() || 'git fetch failed')

    const branch = sameRepo ? pr.headRefName : `pr/${n}`
    const existing = (await git.branches(cwd)).find((b) => b.name === branch)
    if (existing?.worktree) return { branch, path: existing.worktree }
    const base = sameRepo ? `${remote}/${pr.headRefName}` : `${remote}/pr/${n}`
    const created = await git.createWorktree(cwd, { branch, baseBranch: base })
    if (sameRepo) {
      await this.run('git', ['branch', `--set-upstream-to=${remote}/${pr.headRefName}`], {
        cwd: created.path,
      }).catch(() => undefined)
    }
    return { branch, path: created.path }
  }

  /** The git remote that points at the GitHub repo (else `origin`). */
  private async remoteFor(cwd: string, repo: string | undefined): Promise<string> {
    const res = await this.run('git', ['remote', '-v'], { cwd })
    const lines = res.code === 0 ? res.stdout.split('\n') : []
    const want = repo?.toLowerCase()
    const match = lines
      .map((l) => l.split(/\s+/))
      .find(
        ([, url]) =>
          want &&
          url &&
          url
            .toLowerCase()
            .replace(/\.git$/, '')
            .endsWith(want),
      )
    return match?.[0] ?? (lines.length ? (lines[0]!.split(/\s+/)[0] ?? 'origin') : 'origin')
  }

  /** Opens a pull request for the current branch (which must already be pushed). */
  async createPullRequest(
    cwd: string,
    options: { title: string; body: string; draft?: boolean; base?: string },
  ): Promise<string> {
    this.prCache.delete(cwd)
    const stdout = await this.withBodyFile(options.body, (file) => {
      const args = ['pr', 'create', '--title', options.title, '--body-file', file]
      if (options.draft) args.push('--draft')
      if (options.base) args.push('--base', options.base)
      return this.ok(cwd, args, 60_000)
    })
    const url = stdout
      .trim()
      .split(/\s+/)
      .findLast((t) => t.startsWith('http'))
    if (!url) throw new GithubError('GitHub did not return the pull request link')
    return url
  }
}
