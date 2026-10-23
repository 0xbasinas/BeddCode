import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService, parseLog, parseNumstat } from './git.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const tmp = () => {
  const d = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-git-')))
  dirs.push(d)
  return d
}

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })

/** A repo with one commit on `main` containing a.txt and b.txt. */
function repo() {
  const dir = tmp()
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'Test User')
  sh(dir, 'config', 'user.email', 'test@example.com')
  sh(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(path.join(dir, 'b.txt'), 'bee\n')
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-q', '-m', 'initial')
  return dir
}

const git = new GitService()

describe('GitService.info', () => {
  it('reports a repository, its branch and default branch', async () => {
    const dir = repo()
    const info = await git.info(dir)
    expect(info).toMatchObject({
      isRepo: true,
      branch: 'main',
      defaultBranch: 'main',
      isWorktree: false,
    })
    expect(path.resolve(info.root!)).toBe(path.resolve(dir))
    expect(info.upstream).toBeUndefined()
  })

  it('reports a plain folder as not a repository, and rejects a missing one', async () => {
    expect(await git.info(tmp())).toEqual({ isRepo: false })
    await expect(git.info(path.join(tmp(), 'nope'))).rejects.toThrow('does not exist')
  })

  it('works from a subfolder', async () => {
    const dir = repo()
    mkdirSync(path.join(dir, 'sub'))
    const info = await git.info(path.join(dir, 'sub'))
    expect(path.resolve(info.root!)).toBe(path.resolve(dir))
  })
})

describe('GitService.status and diff', () => {
  it('lists modified, deleted and untracked files with line counts', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    rmSync(path.join(dir, 'b.txt'))
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src', 'new.ts'), 'x\ny\n')

    const status = await git.status(dir)
    expect(status.branch).toBe('main')
    expect(status.files).toEqual([
      { path: 'a.txt', status: 'M', staged: false, added: 2, removed: 1 },
      { path: 'b.txt', status: 'D', staged: false, added: 0, removed: 1 },
      { path: 'src/new.ts', status: 'A', staged: false, added: 2, removed: 0 },
    ])
  })

  it('marks staged changes and follows renames', async () => {
    const dir = repo()
    sh(dir, 'mv', 'b.txt', 'c.txt')
    const status = await git.status(dir)
    expect(status.files).toEqual([
      { path: 'c.txt', status: 'R', staged: true, added: 0, removed: 0 },
    ])
  })

  it('returns a clean list when nothing changed', async () => {
    expect((await git.status(repo())).files).toEqual([])
  })

  it('works in a repository with no commits yet', async () => {
    const dir = tmp()
    sh(dir, 'init', '-q', '-b', 'main')
    writeFileSync(path.join(dir, 'first.txt'), 'hello\n')
    const status = await git.status(dir)
    expect(status.files).toEqual([
      { path: 'first.txt', status: 'A', staged: false, added: 1, removed: 0 },
    ])
    expect((await git.log(dir)).unpushed).toEqual([])
  })

  it('builds a diff for tracked, deleted and untracked files', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(path.join(dir, 'new.txt'), 'n1\nn2\n')

    const tracked = await git.diff(dir, 'a.txt')
    expect(tracked).toMatchObject({ added: 1, removed: 1, truncated: false })
    expect(tracked.patch).toContain('-two')
    expect(tracked.patch).toContain('+TWO')
    expect(tracked.patch.startsWith('@@')).toBe(true)

    expect(await git.diff(dir, 'new.txt')).toMatchObject({
      added: 2,
      removed: 0,
      patch: '+n1\n+n2',
    })

    rmSync(path.join(dir, 'b.txt'))
    expect(await git.diff(dir, 'b.txt')).toMatchObject({ added: 0, removed: 1 })
  })

  it('flags binary files instead of dumping them', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 1, 2, 0, 3]))
    expect(await git.diff(dir, 'img.bin')).toMatchObject({ truncated: true, patch: '' })
  })

  it('refuses paths outside the repository', async () => {
    await expect(git.diff(repo(), '../secret')).rejects.toThrow('inside the repository')
  })
})

describe('GitService.commit, push and log', () => {
  it('commits only the chosen files and leaves the rest uncommitted', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.txt'), 'changed\n')
    writeFileSync(path.join(dir, 'b.txt'), 'changed too\n')
    sh(dir, 'add', 'b.txt') // staged elsewhere; must not be swept in

    const { hash, pushed } = await git.commit(dir, 'fix: only a', ['a.txt'])
    expect(pushed).toBe(false)
    expect(sh(dir, 'rev-parse', 'HEAD').trim()).toBe(hash)
    expect(sh(dir, 'show', '--name-only', '--pretty=format:%s', 'HEAD').trim()).toBe(
      'fix: only a\n\na.txt'.replace('\n\n', '\n'),
    )
    expect((await git.status(dir)).files.map((f) => f.path)).toEqual(['b.txt'])
  })

  it('commits new and deleted files too', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'new.txt'), 'n\n')
    rmSync(path.join(dir, 'b.txt'))
    await git.commit(dir, 'chore: add and remove', ['new.txt', 'b.txt'])
    expect((await git.status(dir)).files).toEqual([])
    expect(existsSync(path.join(dir, 'b.txt'))).toBe(false)
  })

  it("reports git's own error when there is nothing to commit", async () => {
    await expect(git.commit(repo(), 'empty', ['a.txt'])).rejects.toThrow()
  })

  it('pushes to a remote, sets the upstream, and splits the log into unpushed and pushed', async () => {
    const dir = repo()
    const remote = tmp()
    sh(remote, 'init', '-q', '--bare', '-b', 'main')
    sh(dir, 'remote', 'add', 'origin', remote)

    sh(dir, 'checkout', '-q', '-b', 'feat/x')
    writeFileSync(path.join(dir, 'a.txt'), 'x1\n')
    await git.commit(dir, 'feat: first', ['a.txt'])
    await git.push(dir)
    expect((await git.info(dir)).upstream).toBe('origin/feat/x')

    writeFileSync(path.join(dir, 'a.txt'), 'x2\nmore\n')
    await git.commit(dir, 'feat: second', ['a.txt'])

    const info = await git.info(dir)
    expect(info).toMatchObject({ ahead: 1, behind: 0 })
    const log = await git.log(dir)
    expect(log.base).toBe('main')
    expect(log.unpushed.map((c) => c.subject)).toEqual(['feat: second'])
    expect(log.pushed.map((c) => c.subject)).toEqual(['feat: first'])
    expect(log.unpushed[0]).toMatchObject({ author: 'Test User', added: 2, removed: 1 })
    expect(log.unpushed[0]!.files).toEqual([{ path: 'a.txt', added: 2, removed: 1 }])
  })

  it('treats every branch commit as unpushed when there is no upstream', async () => {
    const dir = repo()
    sh(dir, 'checkout', '-q', '-b', 'topic')
    writeFileSync(path.join(dir, 'a.txt'), 'z\n')
    await git.commit(dir, 'topic work', ['a.txt'])
    const log = await git.log(dir)
    expect(log.unpushed.map((c) => c.subject)).toEqual(['topic work'])
    expect(log.pushed).toEqual([])
  })

  it('commit with push=true pushes in one step', async () => {
    const dir = repo()
    const remote = tmp()
    sh(remote, 'init', '-q', '--bare', '-b', 'main')
    sh(dir, 'remote', 'add', 'origin', remote)
    writeFileSync(path.join(dir, 'a.txt'), 'p\n')
    const res = await git.commit(dir, 'ship it', ['a.txt'], true)
    expect(res.pushed).toBe(true)
    expect(sh(remote, 'log', '--pretty=%s', '-1', 'main').trim()).toBe('ship it')
  })

  it('refuses to push when there is no remote', async () => {
    await expect(git.push(repo())).rejects.toThrow()
  })
})

describe('GitService worktrees and branches', () => {
  it('creates a worktree under .wt on a new branch and keeps it out of status', async () => {
    const dir = repo()
    const wt = await git.createWorktree(dir, { branch: 'fix/rate-limiter' })
    expect(wt).toMatchObject({ branch: 'fix/rate-limiter', baseBranch: 'main' })
    expect(path.dirname(wt.path)).toBe(path.join(dir, '.wt'))
    expect(path.basename(wt.path)).toBe('fix-rate-limiter')
    expect(existsSync(path.join(wt.path, 'a.txt'))).toBe(true)

    expect(readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('/.wt/')
    expect((await git.status(dir)).files).toEqual([])

    const info = await git.info(wt.path)
    expect(info).toMatchObject({ isRepo: true, isWorktree: true, branch: 'fix/rate-limiter' })
    expect(path.resolve(info.mainRoot!)).toBe(path.resolve(dir))
  })

  it('generates a branch name and unique folders when none is given', async () => {
    const dir = repo()
    const a = await git.createWorktree(dir)
    const b = await git.createWorktree(dir)
    expect(a.branch).toMatch(/^beddcode\/[0-9a-f]{6}$/)
    expect(a.path).not.toBe(b.path)
  })

  it('starts from the requested base branch', async () => {
    const dir = repo()
    sh(dir, 'checkout', '-q', '-b', 'develop')
    writeFileSync(path.join(dir, 'dev.txt'), 'd\n')
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-q', '-m', 'dev work')
    sh(dir, 'checkout', '-q', 'main')

    const wt = await git.createWorktree(dir, { branch: 'topic', baseBranch: 'develop' })
    expect(wt.baseBranch).toBe('develop')
    expect(existsSync(path.join(wt.path, 'dev.txt'))).toBe(true)
  })

  it('lists branches newest first and marks the ones with a worktree', async () => {
    const dir = repo()
    const wt = await git.createWorktree(dir, { branch: 'feat/quota' })
    sh(dir, 'branch', 'plain')
    const branches = await git.branches(dir)
    expect(branches.map((b) => b.name).sort()).toEqual(['feat/quota', 'main', 'plain'])
    expect(branches.find((b) => b.name === 'main')).toMatchObject({ current: true })
    expect(branches.find((b) => b.name === 'feat/quota')?.worktree).toBe(path.resolve(wt.path))
    expect(branches.find((b) => b.name === 'plain')?.worktree).toBeUndefined()
  })

  it('removes a linked worktree but never the main checkout', async () => {
    const dir = repo()
    const wt = await git.createWorktree(dir, { branch: 'gone' })
    expect(await git.removeWorktree(dir)).toBe(false)
    expect(existsSync(dir)).toBe(true)
    expect(await git.removeWorktree(wt.path)).toBe(true)
    expect(existsSync(wt.path)).toBe(false)
    expect(await git.removeWorktree(wt.path)).toBe(false)
    // The branch survives so the work is not lost.
    expect((await git.branches(dir)).some((b) => b.name === 'gone')).toBe(true)
  })

  it('cleans up an empty folder an earlier removal left inside .wt, but nothing else', async () => {
    const dir = repo()
    const leftover = path.join(dir, '.wt', 'stale')
    mkdirSync(leftover, { recursive: true })
    expect(await git.removeWorktree(leftover)).toBe(true)
    expect(existsSync(leftover)).toBe(false)

    const notEmpty = path.join(dir, '.wt', 'busy')
    mkdirSync(notEmpty, { recursive: true })
    writeFileSync(path.join(notEmpty, 'keep.txt'), 'x')
    expect(await git.removeWorktree(notEmpty)).toBe(false)
    expect(existsSync(notEmpty)).toBe(true)

    const elsewhere = path.join(dir, 'plain-empty')
    mkdirSync(elsewhere)
    expect(await git.removeWorktree(elsewhere)).toBe(false)
    expect(existsSync(elsewhere)).toBe(true)
  })

  it('reuses an existing free branch instead of failing', async () => {
    const dir = repo()
    sh(dir, 'branch', 'existing')
    const wt = await git.createWorktree(dir, { branch: 'existing' })
    expect((await git.info(wt.path)).branch).toBe('existing')
  })
})

describe('parsers', () => {
  it('parses numstat output including binary files and renames', () => {
    const out = '3\t1\ta.txt\0-\t-\timg.png\0'
    expect(parseNumstat(out).get('a.txt')).toEqual({ added: 3, removed: 1 })
    expect(parseNumstat(out).get('img.png')).toEqual({ added: 0, removed: 0 })
    const renamed = '0\t0\t\0old.txt\0new.txt\0'
    expect(parseNumstat(renamed).get('new.txt')).toEqual({ added: 0, removed: 0 })
  })

  it('parses log records with file stats', () => {
    const out = '\x1eabc\x1fAnn\x1f1700000000\x1ffix: a thing\n2\t1\tsrc/a.ts\n5\t0\tsrc/b.ts\n'
    expect(parseLog(out)).toEqual([
      {
        hash: 'abc',
        author: 'Ann',
        at: 1_700_000_000_000,
        subject: 'fix: a thing',
        added: 7,
        removed: 1,
        files: [
          { path: 'src/a.ts', added: 2, removed: 1 },
          { path: 'src/b.ts', added: 5, removed: 0 },
        ],
      },
    ])
  })
})
