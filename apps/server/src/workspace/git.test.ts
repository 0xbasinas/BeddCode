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
import { runCommand } from '@beddcode/shared'

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
      { path: 'c.txt', oldPath: 'b.txt', status: 'R', staged: true, added: 0, removed: 0 },
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
    expect(sh(dir, 'diff', '--cached', '--name-only').trim()).toBe('b.txt')
  })

  it('commits new and deleted files too', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'new.txt'), 'n\n')
    rmSync(path.join(dir, 'b.txt'))
    await git.commit(dir, 'chore: add and remove', ['new.txt', 'b.txt'])
    expect((await git.status(dir)).files).toEqual([])
    expect(existsSync(path.join(dir, 'b.txt'))).toBe(false)
  })

  it('commits files whose deletion is already staged (git rm)', async () => {
    const dir = repo()
    sh(dir, 'rm', '-q', 'b.txt')
    writeFileSync(path.join(dir, 'a.txt'), 'changed\n')
    const { hash } = await git.commit(dir, 'chore: remove b, edit a', ['b.txt', 'a.txt'])
    expect(hash).toMatch(/^[0-9a-f]{40}$/)
    expect((await git.status(dir)).files).toEqual([])
    expect(existsSync(path.join(dir, 'b.txt'))).toBe(false)
  })

  it('commits an initial selection while preserving an unrelated staged file', async () => {
    const dir = tmp()
    sh(dir, 'init', '-q', '-b', 'main')
    sh(dir, 'config', 'user.name', 'Test')
    sh(dir, 'config', 'user.email', 't@example.com')
    sh(dir, 'config', 'commit.gpgsign', 'false')
    writeFileSync(path.join(dir, 'a.txt'), 'a')
    writeFileSync(path.join(dir, 'b.txt'), 'b')
    sh(dir, 'add', 'b.txt')
    await git.commit(dir, 'feat: first file', ['a.txt'])
    expect(sh(dir, 'ls-tree', '--name-only', 'HEAD').trim()).toBe('a.txt')
    expect(sh(dir, 'diff', '--cached', '--name-only').trim()).toBe('b.txt')
  })

  it('commits both sides of a selected rename', async () => {
    const dir = repo()
    sh(dir, 'mv', 'a.txt', 'renamed.txt')
    await git.commit(dir, 'refactor: rename file', ['renamed.txt'])
    expect((await git.status(dir)).files).toEqual([])
    expect(sh(dir, 'ls-tree', '--name-only', 'HEAD')).not.toContain('a.txt')
  })

  it('serializes commits sharing an index and treats special filenames literally', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.txt'), 'changed a')
    writeFileSync(path.join(dir, '[a].txt'), 'literal file')
    const first = await git.commit(dir, 'feat: literal filename', ['[a].txt'])
    expect(sh(dir, 'show', '--format=', '--name-only', first.hash).trim()).toBe('[a].txt')
    writeFileSync(path.join(dir, 'b.txt'), 'changed b')
    const commits = await Promise.all([
      git.commit(dir, 'fix: change a', ['a.txt']),
      git.commit(dir, 'fix: change b', ['b.txt']),
    ])
    expect(commits[0]!.hash).not.toBe(commits[1]!.hash)
    expect((await git.status(dir)).files).toEqual([])
  })

  it('returns a saved commit when pushing fails so retrying only needs push', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.txt'), 'changed')
    const result = await git.commit(dir, 'fix: change file', ['a.txt'], true)
    expect(result).toMatchObject({ pushed: false, pushError: expect.any(String) })
    expect(sh(dir, 'rev-parse', 'HEAD').trim()).toBe(result.hash)
    expect((await git.status(dir)).files).toEqual([])
  })

  it('generates context only for selected files and branch commits', async () => {
    const dir = repo()
    sh(dir, 'checkout', '-q', '-b', 'feature')
    writeFileSync(path.join(dir, 'a.txt'), 'visible change\n')
    writeFileSync(path.join(dir, 'b.txt'), 'unselected content\n')
    const draft = await git.generationContext(dir, 'commit', ['a.txt'])
    expect(draft.text).toContain('visible change')
    expect(draft.text).not.toContain('unselected content')
    await git.commit(dir, 'feat: visible', ['a.txt'])
    const pr = await git.generationContext(dir, 'pr', [], 'main')
    expect(pr.text).toContain('feat: visible')
    expect(pr.text).not.toContain('unselected content')
    await expect(git.generationContext(dir, 'pr', [], '--help')).rejects.toThrow('valid base')
  })

  it('prepares ordered multi-file context without rediscovering the repository per file', async () => {
    const dir = repo()
    const files = Array.from({ length: 16 }, (_, i) => `selected-${i}.txt`)
    for (const file of files) writeFileSync(path.join(dir, file), 'initial\n')
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-qm', 'selected fixtures')
    for (const file of files) writeFileSync(path.join(dir, file), `updated ${file}\n`)
    writeFileSync(path.join(dir, 'new.txt'), 'new untracked content\n')
    writeFileSync(path.join(dir, 'b.txt'), 'excluded content\n')
    let calls = 0
    const service = new GitService((file, args, options) => {
      calls++
      return runCommand(file, args, options)
    })
    const selected = [...files, 'new.txt']
    const result = await service.generationContext(dir, 'commit', selected)
    expect(result.truncated).toBe(false)
    expect(result.text).not.toContain('excluded content')
    let previous = -1
    for (const file of selected) {
      const position = result.text.indexOf(`File: ${JSON.stringify(file)}`)
      expect(position).toBeGreaterThan(previous)
      previous = position
    }
    expect(result.text).toContain('new untracked content')
    // A broad process budget catches repeated metadata discovery without timing-dependent tests.
    expect(calls).toBeLessThan(50)
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

describe('GitService snapshots (turn checkpoints)', () => {
  it('snapshots tracked and untracked files without touching the index, HEAD or branches', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'staged.txt'), 'staged\n')
    sh(dir, 'add', 'staged.txt')
    writeFileSync(path.join(dir, 'loose.txt'), 'untracked\n')
    writeFileSync(path.join(dir, '.gitignore'), 'ignored.log\n')
    writeFileSync(path.join(dir, 'ignored.log'), 'noise\n')
    const statusBefore = sh(dir, 'status', '--porcelain')
    const head = sh(dir, 'rev-parse', 'HEAD')

    const snap = await git.snapshot(dir, 'refs/beddcode/checkpoints/s1/t1-before')
    expect(sh(dir, 'status', '--porcelain')).toBe(statusBefore)
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(head)
    expect(sh(dir, 'rev-parse', 'refs/beddcode/checkpoints/s1/t1-before').trim()).toBe(snap)
    const files = sh(dir, 'ls-tree', '-r', '--name-only', snap).trim().split('\n')
    expect(files.sort()).toEqual(['.gitignore', 'a.txt', 'b.txt', 'loose.txt', 'staged.txt'])
    expect(sh(dir, 'branch', '--list').trim()).toBe('* main')
  })

  it('lists what changed between snapshots, diffs a file, and undoes the changes', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'keep.txt'), 'untracked and untouched\n')
    const before = await git.snapshot(dir)
    writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    rmSync(path.join(dir, 'b.txt'))
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src', 'new.ts'), 'export const x = 1\n')
    const after = await git.snapshot(dir)

    const { files, truncated } = await git.snapshotChanges(dir, before, after)
    expect(truncated).toBe(false)
    expect(files).toEqual([
      { path: 'a.txt', status: 'M', added: 2, removed: 1 },
      { path: 'b.txt', status: 'D', added: 0, removed: 1 },
      { path: 'src/new.ts', status: 'A', added: 1, removed: 0 },
    ])
    const diff = await git.snapshotDiff(dir, before, after, 'a.txt')
    expect(diff.patch).toContain('+TWO')
    expect(diff.patch).toContain('-two')

    expect(await git.matchesSnapshot(dir, after)).toBe(true)
    expect(await git.restoreSnapshot(dir, before, after)).toBe(3)
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect(readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('bee\n')
    expect(existsSync(path.join(dir, 'src', 'new.ts'))).toBe(false)
    expect(readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('untracked and untouched\n')
    expect(await git.matchesSnapshot(dir, before)).toBe(true)
    expect(sh(dir, 'status', '--porcelain').trim()).toBe('?? keep.txt')
  })

  it('works on a repository with no commits yet, and rejects bad input', async () => {
    const dir = tmp()
    sh(dir, 'init', '-q', '-b', 'main')
    const before = await git.snapshot(dir)
    writeFileSync(path.join(dir, 'first.txt'), 'hello\n')
    const after = await git.snapshot(dir)
    expect((await git.snapshotChanges(dir, before, after)).files).toEqual([
      { path: 'first.txt', status: 'A', added: 1, removed: 0 },
    ])
    await expect(git.snapshotDiff(dir, before, 'HEAD; rm -rf /', 'x')).rejects.toThrow(/snapshot/)
    await expect(git.snapshotDiff(dir, before, after, '../etc/passwd')).rejects.toThrow(/inside/)
  })

  it('drops snapshot refs by prefix', async () => {
    const dir = repo()
    await git.snapshot(dir, 'refs/beddcode/checkpoints/s9/t1-before')
    await git.snapshot(dir, 'refs/beddcode/checkpoints/s9/t1-after')
    await git.dropSnapshots(dir, 'refs/beddcode/checkpoints/s9/')
    expect(sh(dir, 'for-each-ref', 'refs/beddcode/').trim()).toBe('')
  })
})
