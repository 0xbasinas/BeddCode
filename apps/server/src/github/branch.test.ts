import { describe, expect, it } from 'vitest'
import type { Job } from '@beddcode/github-app/protocol'
import { chooseBase, mentionedPaths, namedBranch } from './branch.ts'

/** A repo with these remote branches (newest first) and which files each has. */
function repo(files: Record<string, string[]>) {
  const branches = Object.keys(files)
  return async (_cwd: string, args: string[]) => {
    if (args[0] === 'for-each-ref')
      return { code: 0, out: branches.map((b) => `origin/${b}`).join('\n') }
    if (args[0] === 'cat-file') {
      const [ref, path] = args[2]!.replace(/^origin\//, '').split(':') as [string, string]
      return { code: files[ref]?.includes(path) ? 0 : 1, out: '' }
    }
    return { code: 0, out: '' }
  }
}

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: 'j',
    repo: 'o/r',
    number: 5,
    isPullRequest: false,
    command: { verb: 'ask', extra: '' },
    base: { ref: 'main' },
    ...over,
  }) as Job

const choose = (
  git: ReturnType<typeof repo>,
  text: string,
  over: Partial<Job> = {},
  configured?: string,
) => chooseBase(git, '/r', job(over), { text, configured })

describe('chooseBase', () => {
  const git = repo({
    'nightly-desktop': ['packages/github-app/src/policy.ts', 'README.md'],
    'feature/x': ['README.md'],
    main: ['README.md'],
  })

  it('finds the branch that has the files the request talks about', async () => {
    const r = await choose(git, 'add a comment at the top of packages/github-app/src/policy.ts')
    expect(r.ref).toBe('nightly-desktop')
    expect(r.reason).toContain('policy.ts')
  })
  it('stays on the default branch when it has the files', async () => {
    expect((await choose(git, 'fix README.md')).ref).toBe('main')
    expect((await choose(git, 'make the page load faster')).ref).toBe('main')
  })
  it('uses a branch the comment names, but only a real one', async () => {
    expect((await choose(git, 'please work on branch feature/x and fix the typo')).ref).toBe(
      'feature/x',
    )
    expect((await choose(git, 'start from nightly-desktop')).ref).toBe('nightly-desktop')
    expect((await choose(git, 'base=feature/x')).ref).toBe('feature/x')
    expect((await choose(git, 'start from scratch, use sonnet on low')).ref).toBe('main')
  })
  it('keeps a pull request on its own branch', async () => {
    const r = await choose(git, 'work on branch main', {
      isPullRequest: true,
      head: { ref: 'feature/x', sha: 'a' },
    })
    expect(r).toMatchObject({ ref: 'feature/x', reason: 'the pull request branch' })
  })
  it('uses the branch of a pull request it points at, then the repo setting', async () => {
    expect(
      (await choose(git, 'fix it', { baseHint: { ref: 'nightly-desktop', number: 102 } })).reason,
    ).toContain('#102')
    expect((await choose(git, 'fix it', {}, 'feature/x')).ref).toBe('feature/x')
    // A hint or setting that is not a branch on the remote is ignored.
    expect(
      (await choose(git, 'fix it', { baseHint: { ref: 'gone', number: 1 } }, 'nope')).ref,
    ).toBe('main')
  })
  it('does not pick one of its own branches or a branch with fewer of the files', async () => {
    const g = repo({ 'beddcode/issue-1-ab': ['a/b.ts'], other: ['x/y.ts'], main: [] })
    expect((await choose(g, 'edit a/b.ts')).ref).toBe('main')
  })
})

describe('helpers', () => {
  it('picks file paths out of text', () => {
    expect(
      mentionedPaths(
        'see packages/github-app/src/policy.ts and `apps/web/App.tsx`, not a/b or 1.5',
      ),
    ).toEqual(['packages/github-app/src/policy.ts', 'apps/web/App.tsx'])
  })
  it('matches branch names written as branches', () => {
    const branches = ['main', 'feature/x', 'feature/x-2']
    expect(namedBranch('on branch feature/x-2', branches)).toBe('feature/x-2')
    expect(namedBranch('the main idea is simple', branches)).toBeUndefined()
    expect(namedBranch('on the feature/x branch', branches)).toBe('feature/x')
  })
})
