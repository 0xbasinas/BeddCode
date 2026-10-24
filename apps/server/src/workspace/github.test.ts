import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RunResult } from '@beddcode/shared'
import { GithubError, GithubService, checkState, rollup } from './github.ts'
import type { GitService, Runner } from './git.ts'

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr })

function service(handler: (args: string[], file: string) => RunResult | Promise<RunResult>) {
  const calls: string[][] = []
  /** What each `--body-file` held while gh ran (the file is gone afterwards). */
  const bodies: string[] = []
  const run: Runner = async (file, args) => {
    calls.push(file === 'gh' ? args : [file, ...args])
    const i = args.indexOf('--body-file')
    if (i >= 0) bodies.push(readFileSync(args[i + 1]!, 'utf8'))
    return handler(args, file)
  }
  return { gh: new GithubService(run), calls, bodies }
}

describe('GithubService.pullRequest', () => {
  it("maps the CLI's JSON into a pull request", async () => {
    const { gh, calls } = service(() =>
      ok(
        JSON.stringify({
          number: 318,
          title: 'Fix refill',
          url: 'https://github.com/o/r/pull/318',
          state: 'OPEN',
          isDraft: false,
          body: 'Restores the timestamp.',
          headRefName: 'fix/rate-limiter',
          baseRefName: 'main',
          createdAt: '2026-10-21T10:00:00Z',
          reviewDecision: 'APPROVED',
          statusCheckRollup: [
            { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'integration', status: 'IN_PROGRESS', conclusion: '' },
            { context: 'ci/legacy', state: 'FAILURE' },
          ],
          files: [{ path: 'src/a.ts', additions: 18, deletions: 6 }],
        }),
      ),
    )
    const pr = await gh.pullRequest('/repo')
    expect(calls[0]?.slice(0, 2)).toEqual(['pr', 'view'])
    expect(pr).toMatchObject({
      number: 318,
      state: 'OPEN',
      headBranch: 'fix/rate-limiter',
      baseBranch: 'main',
      reviewDecision: 'APPROVED',
      createdAt: Date.parse('2026-10-21T10:00:00Z'),
      files: [{ path: 'src/a.ts', added: 18, removed: 6 }],
    })
    expect(pr?.checks).toEqual([
      { name: 'build', state: 'success' },
      { name: 'integration', state: 'pending' },
      { name: 'ci/legacy', state: 'failure' },
    ])
  })

  it('returns null when the branch has no pull request', async () => {
    const { gh } = service(() => fail('no pull requests found for branch "x"'))
    expect(await gh.pullRequest('/repo')).toBeNull()
  })

  it('explains sign-in, missing remote and missing CLI problems', async () => {
    const auth = service(() => fail('To get started with GitHub CLI, please run:  gh auth login'))
    await expect(auth.gh.pullRequest('/r')).rejects.toThrow('gh auth login')

    const remote = service(() =>
      fail(
        'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`',
      ),
    )
    await expect(remote.gh.pullRequest('/r')).rejects.toThrow('no GitHub remote')

    const missing = new GithubService(async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    })
    await expect(missing.pullRequest('/r')).rejects.toBeInstanceOf(GithubError)
    await expect(missing.pullRequest('/r')).rejects.toThrow('not installed')
  })
})

describe('GithubService.createPullRequest', () => {
  it('passes title, body, draft and base and returns the link', async () => {
    const { gh, calls, bodies } = service(() =>
      ok('Creating pull request...\nhttps://github.com/o/r/pull/9\n'),
    )
    const url = await gh.createPullRequest('/repo', {
      title: 'T',
      body: 'B',
      draft: true,
      base: 'develop',
    })
    expect(url).toBe('https://github.com/o/r/pull/9')
    expect(calls[0]?.slice(0, 5)).toEqual(['pr', 'create', '--title', 'T', '--body-file'])
    expect(calls[0]?.slice(6)).toEqual(['--draft', '--base', 'develop'])
    expect(bodies[0]).toBe('B')
  })

  it('surfaces the CLI error', async () => {
    const { gh } = service(() => fail('a pull request for branch "x" already exists'))
    await expect(gh.createPullRequest('/repo', { title: 'T', body: '' })).rejects.toThrow(
      'already exists',
    )
  })
})

describe('checkState', () => {
  it('classifies check runs and legacy statuses', () => {
    expect(checkState({ conclusion: 'SUCCESS' })).toBe('success')
    expect(checkState({ conclusion: 'TIMED_OUT' })).toBe('failure')
    expect(checkState({ conclusion: 'SKIPPED' })).toBe('skipped')
    expect(checkState({ status: 'QUEUED' })).toBe('pending')
    expect(checkState({ state: 'ERROR' })).toBe('failure')
  })
})

const REPO = JSON.stringify({
  nameWithOwner: 'o/r',
  url: 'https://github.com/o/r',
  defaultBranchRef: { name: 'main' },
  viewerPermission: 'WRITE',
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: false,
  deleteBranchOnMerge: false,
})

describe('GithubService.status', () => {
  it('is ready with the login, repo and allowed merge methods', async () => {
    const { gh } = service((args) => (args[0] === 'api' ? ok('octo\n') : ok(REPO)))
    expect(await gh.status('/r')).toEqual({
      state: 'ready',
      login: 'octo',
      repo: 'o/r',
      url: 'https://github.com/o/r',
      defaultBranch: 'main',
      permission: 'WRITE',
      mergeMethods: ['squash', 'merge'],
      deleteBranchOnMerge: false,
    })
  })
  it('tells not installed, signed out and no GitHub repo apart', async () => {
    const missing = new GithubService(async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    })
    expect(await missing.status('/r')).toEqual({ state: 'not-installed' })
    const out = service(() => ({
      code: 4,
      stdout: '',
      stderr: 'To get started with GitHub CLI, please run:  gh auth login',
    }))
    expect(await out.gh.status('/r')).toEqual({ state: 'signed-out' })
    const none = service((args) =>
      args[0] === 'api'
        ? ok('octo')
        : fail(
            'none of the git remotes configured for this repository point to a known GitHub host',
          ),
    )
    expect(await none.gh.status('/r')).toEqual({ state: 'no-repo', login: 'octo' })
  })
  it('caches a ready answer for a minute', async () => {
    const { gh, calls } = service((args) => (args[0] === 'api' ? ok('octo') : ok(REPO)))
    await gh.status('/r')
    await gh.status('/r')
    expect(calls).toHaveLength(2)
    await gh.status('/r', true)
    expect(calls).toHaveLength(4)
  })
})

describe('GithubService.list', () => {
  const row = (over: Record<string, unknown>) => ({
    number: 1,
    title: 'A',
    url: 'u',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'octo' },
    headRefName: 'a',
    baseRefName: 'main',
    updatedAt: '2026-10-20T10:00:00Z',
    statusCheckRollup: [],
    reviewDecision: '',
    additions: 3,
    deletions: 1,
    isCrossRepository: false,
    ...over,
  })
  it('asks gh for each filter', async () => {
    const { gh, calls } = service(() => ok('[]'))
    await gh.list('/r', 'open')
    await gh.list('/r', 'mine')
    await gh.list('/r', 'review')
    await gh.list('/r', 'closed', 10)
    expect(calls.map((c) => c.slice(6))).toEqual([
      ['--state', 'open'],
      ['--state', 'open', '--author', '@me'],
      ['--state', 'open', '--search', 'review-requested:@me'],
      ['--state', 'closed'],
    ])
    expect(calls[3]?.slice(0, 4)).toEqual(['pr', 'list', '--limit', '10'])
  })
  it('sums up checks and sorts by last activity', async () => {
    const { gh } = service(() =>
      ok(
        JSON.stringify([
          row({ number: 1, statusCheckRollup: [{ conclusion: 'SUCCESS' }] }),
          row({
            number: 2,
            updatedAt: '2026-10-22T10:00:00Z',
            isDraft: true,
            reviewDecision: 'APPROVED',
            isCrossRepository: true,
            statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }],
          }),
        ]),
      ),
    )
    const items = await gh.list('/r', 'open')
    expect(items.map((p) => p.number)).toEqual([2, 1])
    expect(items[0]).toMatchObject({
      isDraft: true,
      author: 'octo',
      checks: 'pending',
      checkCounts: { total: 2, passed: 1, failed: 0, pending: 1 },
      reviewDecision: 'APPROVED',
      fromFork: true,
      added: 3,
      removed: 1,
    })
    expect(items[1]?.checks).toBe('success')
    expect(items[1]?.reviewDecision).toBeUndefined()
  })
  it('rolls failures above pending', () => {
    expect(rollup([{ conclusion: 'FAILURE' }, { status: 'QUEUED' }]).checks).toBe('failure')
    expect(rollup([{ conclusion: 'SKIPPED' }]).checks).toBe('skipped')
    expect(rollup([])).toEqual({})
  })
})

describe('GithubService.view', () => {
  it('merges comments and reviews into one timeline', async () => {
    const { gh, calls } = service(() =>
      ok(
        JSON.stringify({
          number: 7,
          title: 'T',
          url: 'u',
          state: 'OPEN',
          isDraft: false,
          body: 'Body',
          headRefName: 'feat',
          baseRefName: 'main',
          author: { login: 'octo' },
          headRefOid: 'abc',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', detailsUrl: 'https://ci' }],
          comments: [{ author: { login: 'b' }, body: 'later', createdAt: '2026-10-22T00:00:00Z' }],
          reviews: [
            {
              author: { login: 'c' },
              body: '',
              state: 'APPROVED',
              submittedAt: '2026-10-21T00:00:00Z',
            },
            {
              author: { login: 'd' },
              body: '',
              state: 'COMMENTED',
              submittedAt: '2026-10-21T01:00:00Z',
            },
          ],
        }),
      ),
    )
    const pr = await gh.view('/r', 7)
    expect(calls[0]?.slice(0, 3)).toEqual(['pr', 'view', '7'])
    expect(pr).toMatchObject({ author: 'octo', headOid: 'abc', mergeState: 'CLEAN' })
    expect(pr.checks[0]).toMatchObject({ state: 'success', url: 'https://ci' })
    expect(pr.timeline.map((t) => [t.kind, t.author, t.state])).toEqual([
      ['review', 'c', 'APPROVED'],
      ['comment', 'b', undefined],
    ])
  })
})

describe('GithubService.act', () => {
  it('maps each action onto gh', async () => {
    const { gh, calls, bodies } = service(() => ok(''))
    await gh.act('/r', 5, { action: 'ready' })
    await gh.act('/r', 5, { action: 'draft' })
    await gh.act('/r', 5, { action: 'reopen' })
    await gh.act('/r', 5, { action: 'comment', body: 'Looks good\n\n- one' })
    await gh.act('/r', 5, { action: 'close', comment: 'Superseded' })
    expect(calls.map((c) => c.filter((a) => !a.includes('beddcode-gh-')))).toEqual([
      ['pr', 'ready', '5'],
      ['pr', 'ready', '5', '--undo'],
      ['pr', 'reopen', '5'],
      ['pr', 'comment', '5', '--body-file'],
      ['pr', 'comment', '5', '--body-file'],
      ['pr', 'close', '5'],
    ])
    expect(bodies).toEqual(['Looks good\n\n- one', 'Superseded'])
    // The temp files do not outlive the call.
    const file = calls[3]![4]!
    expect(existsSync(file)).toBe(false)
  })
  it('merges with the chosen method, pinned to the head it saw, and deletes only the remote branch', async () => {
    const { gh, calls } = service((args) =>
      args[1] === 'view'
        ? ok(JSON.stringify({ headRefName: 'feat/x', isCrossRepository: false }))
        : ok(''),
    )
    const res = await gh.act('/r', 9, {
      action: 'merge',
      method: 'squash',
      headOid: 'abc123',
      deleteBranch: true,
    })
    expect(calls[1]).toEqual(['pr', 'merge', '9', '--squash', '--match-head-commit', 'abc123'])
    expect(calls[2]).toEqual([
      'api',
      '--method',
      'DELETE',
      'repos/{owner}/{repo}/git/refs/heads/feat/x',
    ])
    expect(calls.flat()).not.toContain('--delete-branch')
    expect(res.message).toContain('deleted feat/x')
  })
  it('surfaces why a merge was refused', async () => {
    const { gh } = service(() =>
      fail('X Pull request o/r#9 is not mergeable: the base branch policy prohibits the merge.'),
    )
    await expect(gh.act('/r', 9, { action: 'merge', method: 'merge' })).rejects.toThrow(
      'not mergeable',
    )
  })
})

describe('GithubService.checkout', () => {
  const fakeGit = (
    branches: { name: string; current: boolean; at: number; worktree?: string }[] = [],
  ) => {
    const created: unknown[] = []
    const git = {
      info: async () => ({ isRepo: true, root: '/r', branch: 'feat' }),
      branches: async () => branches,
      createWorktree: async (_cwd: string, o: { branch: string; baseBranch: string }) => {
        created.push(o)
        return { path: '/r/.wt/feat', branch: o.branch, baseBranch: o.baseBranch }
      },
    } as unknown as GitService
    return { git, created }
  }
  it('switches this folder with gh pr checkout', async () => {
    const { gh, calls } = service(() => ok(''))
    const { git } = fakeGit()
    expect(await gh.checkout('/r', 3, git)).toEqual({ branch: 'feat', path: '/r' })
    expect(calls).toEqual([['pr', 'checkout', '3']])
  })
  it('fetches the head and adds a worktree on the PR branch, tracking it', async () => {
    const { gh, calls } = service((args, file) => {
      if (file === 'git' && args[0] === 'remote')
        return ok(
          'upstream\thttps://github.com/x/r (fetch)\nmine\tgit@github.com:o/r.git (fetch)\n',
        )
      if (args[0] === 'api') return ok('octo')
      if (args[0] === 'repo') return ok(REPO)
      if (args[1] === 'view')
        return ok(JSON.stringify({ headRefName: 'feat', isCrossRepository: false }))
      return ok('')
    })
    const { git, created } = fakeGit()
    expect(await gh.checkout('/r', 3, git, { worktree: true })).toEqual({
      branch: 'feat',
      path: '/r/.wt/feat',
    })
    expect(calls).toContainEqual([
      'git',
      'fetch',
      '--no-tags',
      'mine',
      '+refs/pull/3/head:refs/remotes/mine/pr/3',
      '+refs/heads/feat:refs/remotes/mine/feat',
    ])
    expect(created).toEqual([{ branch: 'feat', baseBranch: 'mine/feat' }])
    expect(calls.at(-1)).toEqual(['git', 'branch', '--set-upstream-to=mine/feat'])
  })
  it('uses pr/<n> for a fork, and reuses a worktree that has the branch already', async () => {
    const handler = (args: string[], file: string) => {
      if (file === 'git' && args[0] === 'remote')
        return ok('origin\thttps://github.com/o/r.git (fetch)\n')
      if (args[0] === 'api') return ok('octo')
      if (args[0] === 'repo') return ok(REPO)
      if (args[1] === 'view')
        return ok(JSON.stringify({ headRefName: 'main', isCrossRepository: true }))
      return ok('')
    }
    const fork = service(handler)
    const a = fakeGit()
    expect(await fork.gh.checkout('/r', 8, a.git, { worktree: true })).toMatchObject({
      branch: 'pr/8',
    })
    expect(a.created).toEqual([{ branch: 'pr/8', baseBranch: 'origin/pr/8' }])
    const again = service(handler)
    const b = fakeGit([{ name: 'pr/8', current: false, at: 0, worktree: '/r/.wt/pr-8' }])
    expect(await again.gh.checkout('/r', 8, b.git, { worktree: true })).toEqual({
      branch: 'pr/8',
      path: '/r/.wt/pr-8',
    })
    expect(b.created).toEqual([])
  })
})
