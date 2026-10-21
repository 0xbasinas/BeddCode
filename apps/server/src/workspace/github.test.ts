import { describe, expect, it } from 'vitest'
import type { RunResult } from '@beddcode/shared'
import { GithubError, GithubService, checkState } from './github.ts'
import type { Runner } from './git.ts'

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr })

function service(handler: (args: string[]) => RunResult | Promise<RunResult>) {
  const calls: string[][] = []
  const run: Runner = async (_file, args) => {
    calls.push(args)
    return handler(args)
  }
  return { gh: new GithubService(run), calls }
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
    const { gh, calls } = service(() =>
      ok('Creating pull request...\nhttps://github.com/o/r/pull/9\n'),
    )
    const url = await gh.createPullRequest('/repo', {
      title: 'T',
      body: 'B',
      draft: true,
      base: 'develop',
    })
    expect(url).toBe('https://github.com/o/r/pull/9')
    expect(calls[0]).toEqual([
      'pr',
      'create',
      '--title',
      'T',
      '--body',
      'B',
      '--draft',
      '--base',
      'develop',
    ])
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
