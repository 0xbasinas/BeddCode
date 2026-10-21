import type { PullRequest } from '@beddcode/contracts'
import { runCommand } from '@beddcode/shared'
import type { Runner } from './git.ts'

export class GithubError extends Error {}

const defaultRunner: Runner = (file, args, { cwd, timeoutMs }) =>
  runCommand(file, args, {
    cwd,
    timeoutMs: timeoutMs ?? 30_000,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_PAGER: '' },
  })

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

type Check = {
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
}

export function checkState(check: Check): PullRequest['checks'][number]['state'] {
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

/** Pull requests through the user's own signed-in GitHub CLI; we never hold a token. */
export class GithubService {
  constructor(private readonly run: Runner = defaultRunner) {}

  private async gh(cwd: string, args: string[], timeoutMs?: number) {
    let res
    try {
      res = await this.run('gh', args, { cwd, timeoutMs })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new GithubError('The GitHub CLI (gh) is not installed on this host')
      }
      throw err
    }
    return res
  }

  private fail(stderr: string): never {
    const text = stderr.trim()
    if (/none of the git remotes|not a github|no github remote/i.test(text)) {
      throw new GithubError('This repository has no GitHub remote')
    }
    if (/gh auth login|not logged in|authentication/i.test(text)) {
      throw new GithubError('Sign in to GitHub on this host first: run `gh auth login`')
    }
    throw new GithubError(text || 'The GitHub CLI failed')
  }

  /** The pull request for the current branch, or null when there is none. */
  async pullRequest(cwd: string): Promise<PullRequest | null> {
    const res = await this.gh(cwd, ['pr', 'view', '--json', PR_FIELDS])
    if (res.code !== 0) {
      if (/no pull requests found/i.test(res.stderr)) return null
      this.fail(res.stderr)
    }
    const pr = JSON.parse(res.stdout) as {
      number: number
      title: string
      url: string
      state: PullRequest['state']
      isDraft: boolean
      body: string
      headRefName: string
      baseRefName: string
      createdAt?: string
      statusCheckRollup?: Check[]
      reviewDecision?: string
      files?: { path: string; additions: number; deletions: number }[]
    }
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      body: pr.body ?? '',
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      createdAt: pr.createdAt ? Date.parse(pr.createdAt) : undefined,
      checks: (pr.statusCheckRollup ?? []).map((c) => ({
        name: c.name ?? c.context ?? 'check',
        state: checkState(c),
      })),
      reviewDecision: pr.reviewDecision || undefined,
      files: (pr.files ?? []).map((f) => ({
        path: f.path,
        added: f.additions,
        removed: f.deletions,
      })),
    }
  }

  /** Opens a pull request for the current branch (which must already be pushed). */
  async createPullRequest(
    cwd: string,
    options: { title: string; body: string; draft?: boolean; base?: string },
  ): Promise<string> {
    const args = ['pr', 'create', '--title', options.title, '--body', options.body]
    if (options.draft) args.push('--draft')
    if (options.base) args.push('--base', options.base)
    const res = await this.gh(cwd, args, 60_000)
    if (res.code !== 0) this.fail(res.stderr)
    const url = res.stdout
      .trim()
      .split(/\s+/)
      .findLast((t) => t.startsWith('http'))
    if (!url) throw new GithubError('GitHub did not return the pull request link')
    return url
  }
}
