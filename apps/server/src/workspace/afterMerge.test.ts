import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PullRequestDetail } from '@beddcode/contracts'
import { cleanupAfterMerge } from './afterMerge.ts'
import { GitService } from './git.ts'
import type { GithubService } from './github.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const tmp = () => {
  const d = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-merge-')))
  dirs.push(d)
  return d
}
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
const identify = (dir: string) => {
  sh(dir, 'config', 'user.name', 'Test User')
  sh(dir, 'config', 'user.email', 'test@example.com')
  sh(dir, 'config', 'commit.gpgsign', 'false')
}
const commit = (dir: string, file: string, text: string) => {
  writeFileSync(path.join(dir, file), text)
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-q', '-m', `edit ${file}`)
}

/**
 * An origin and a clone on main, with the feature branch pushed from a worktree, then "merged" on
 * origin the way GitHub does it: main moves on by a squash commit the branch does not share.
 */
function setup() {
  const origin = tmp()
  sh(origin, 'init', '-q', '--bare', '-b', 'main')
  const main = tmp()
  sh(main, 'clone', '-q', origin, '.')
  identify(main)
  commit(main, 'a.txt', 'one\n')
  sh(main, 'push', '-q', 'origin', 'main')
  const worktree = path.join(tmp(), 'wt')
  sh(main, 'worktree', 'add', '-q', '-b', 'feat/x', worktree, 'main')
  commit(worktree, 'b.txt', 'feature\n')
  sh(worktree, 'push', '-q', 'origin', 'feat/x')
  const headOid = sh(worktree, 'rev-parse', 'HEAD')
  // GitHub squash-merges: a new commit on origin/main with the same content.
  const other = tmp()
  sh(other, 'clone', '-q', origin, '.')
  identify(other)
  commit(other, 'b.txt', 'feature\n')
  sh(other, 'push', '-q', 'origin', 'main')
  return { main, worktree, headOid }
}

const git = new GitService()
const github = (pr: Partial<PullRequestDetail>) =>
  ({
    view: async () => ({
      state: 'MERGED',
      headBranch: 'feat/x',
      baseBranch: 'main',
      ...pr,
    }),
  }) as unknown as GithubService

const all = { updateBase: true, removeWorktree: true, deleteBranch: true }

describe('cleanupAfterMerge', () => {
  it('updates main, removes the worktree and deletes the branch', async () => {
    const { main, worktree, headOid } = setup()
    const result = await cleanupAfterMerge(
      { git, github: github({ headOid }), removeSessionWorktree: async () => false },
      { cwd: worktree, number: 1, ...all },
    )
    expect(result.steps.map((s) => [s.step, s.status])).toEqual([
      ['update-base', 'done'],
      ['remove-worktree', 'done'],
      ['delete-branch', 'done'],
    ])
    expect(existsSync(worktree)).toBe(false)
    expect(sh(main, 'branch', '--list', 'feat/x')).toBe('')
    // The deleted branch's tip stays reachable.
    expect(sh(main, 'rev-parse', 'refs/beddcode/backup/feat/x')).toBe(headOid)
    expect(result.steps.find((s) => s.step === 'delete-branch')!.detail).toMatch(/copy is kept/)
    expect(sh(main, 'rev-parse', 'HEAD')).toBe(sh(main, 'rev-parse', 'origin/main'))
  })

  it('keeps a worktree that has commits the pull request lacks', async () => {
    const { worktree, headOid } = setup()
    commit(worktree, 'c.txt', 'late\n')
    const result = await cleanupAfterMerge(
      { git, github: github({ headOid }), removeSessionWorktree: async () => false },
      { cwd: worktree, number: 1, ...all },
    )
    const by = Object.fromEntries(result.steps.map((s) => [s.step, s]))
    expect(by['remove-worktree']).toMatchObject({ status: 'skipped' })
    expect(by['remove-worktree']!.detail).toMatch(/local commits/)
    expect(by['delete-branch']).toMatchObject({ status: 'skipped' })
    expect(existsSync(worktree)).toBe(true)
  })

  it('keeps a worktree with uncommitted files', async () => {
    const { worktree, headOid } = setup()
    writeFileSync(path.join(worktree, 'scratch.txt'), 'wip')
    const result = await cleanupAfterMerge(
      { git, github: github({ headOid }), removeSessionWorktree: async () => false },
      { cwd: worktree, number: 1, ...all },
    )
    expect(result.steps.find((s) => s.step === 'remove-worktree')!.detail).toMatch(/uncommitted/)
    expect(existsSync(worktree)).toBe(true)
  })

  it('stops the session through its own removal when given one', async () => {
    const { worktree, headOid } = setup()
    const removed: string[] = []
    await cleanupAfterMerge(
      {
        git,
        github: github({ headOid }),
        removeSessionWorktree: async (id) => (removed.push(id), git.removeWorktree(worktree)),
      },
      { cwd: worktree, number: 1, sessionId: 's1', ...all },
    )
    expect(removed).toEqual(['s1'])
  })

  it('still deletes the branch when removing the worktree failed after unregistering it', async () => {
    const { main, worktree, headOid } = setup()
    const result = await cleanupAfterMerge(
      {
        git,
        github: github({ headOid }),
        removeSessionWorktree: async () => {
          await git.removeWorktree(worktree)
          throw new Error('a file was locked')
        },
      },
      { cwd: worktree, number: 1, sessionId: 's1', ...all },
    )
    const by = Object.fromEntries(result.steps.map((s) => [s.step, s]))
    expect(by['remove-worktree']).toMatchObject({ status: 'failed' })
    expect(by['delete-branch']).toMatchObject({ status: 'done' })
    expect(sh(main, 'branch', '--list', 'feat/x')).toBe('')
  })

  it('never deletes a branch the folder is not standing on', async () => {
    const { main, headOid } = setup()
    sh(main, 'fetch', '-q', 'origin')
    // Not a worktree: the merged branch is the one checked out in the main checkout itself.
    sh(main, 'worktree', 'prune')
    const result = await cleanupAfterMerge(
      { git, github: github({ headOid }), removeSessionWorktree: async () => false },
      { cwd: main, number: 1, updateBase: true, removeWorktree: true, deleteBranch: true },
    )
    // On main, not on the merged branch: it is not this folder's branch, so nothing is deleted.
    expect(result.steps.find((s) => s.step === 'delete-branch')!.status).toBe('skipped')
  })

  it('refuses a pull request that is not merged', async () => {
    const { worktree } = setup()
    await expect(
      cleanupAfterMerge(
        { git, github: github({ state: 'OPEN' }), removeSessionWorktree: async () => false },
        { cwd: worktree, number: 1, ...all },
      ),
    ).rejects.toThrow(/merged/)
  })
})
