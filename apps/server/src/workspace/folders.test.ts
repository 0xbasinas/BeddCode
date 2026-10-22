import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from './git.ts'
import { browseFolders, crumbsOf, FolderBrowseError, readGitHead } from './folders.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beddcode-folders-')))
  dirs.push(d)
  return d
}
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true })

function repo(dir: string, branch = 'main') {
  mkdirSync(dir, { recursive: true })
  sh(dir, 'init', '-q', '-b', branch)
  sh(dir, 'config', 'user.name', 'T')
  sh(dir, 'config', 'user.email', 't@e.com')
  writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

describe('browseFolders', () => {
  it('lists only subfolders, sorted, with git branches and without hidden ones', async () => {
    const root = tmp()
    repo(path.join(root, 'api'), 'feat/routes')
    mkdirSync(path.join(root, 'Notes'))
    mkdirSync(path.join(root, '.secret'))
    writeFileSync(path.join(root, 'readme.md'), 'x')

    const listing = await browseFolders(root, { home: root })
    expect(listing.path).toBe(root)
    expect(listing.home).toBe(root)
    expect(listing.parent).toBe(path.dirname(root))
    expect(listing.truncated).toBe(false)
    expect(listing.entries.map((e) => [e.name, e.isRepo, e.branch])).toEqual([
      ['api', true, 'feat/routes'],
      ['Notes', false, undefined],
    ])
    expect(listing.entries[0]!.path).toBe(path.join(root, 'api'))
    expect(typeof listing.entries[0]!.modifiedAt).toBe('number')
    expect(listing.crumbs.at(-1)).toEqual({ name: path.basename(root), path: root, home: true })

    const hidden = await browseFolders(root, { home: root, showHidden: true })
    expect(hidden.entries.map((e) => e.name)).toContain('.secret')
  })

  it('starts at the home folder and refuses relative or missing paths and files', async () => {
    const home = tmp()
    mkdirSync(path.join(home, 'code'))
    expect((await browseFolders(undefined, { home })).entries.map((e) => e.name)).toEqual(['code'])
    await expect(browseFolders('code', { home })).rejects.toThrow(FolderBrowseError)
    await expect(browseFolders(path.join(home, 'missing'), { home })).rejects.toThrow(
      'does not exist',
    )
    writeFileSync(path.join(home, 'file.txt'), 'x')
    await expect(browseFolders(path.join(home, 'file.txt'), { home })).rejects.toThrow(
      'Not a folder',
    )
  })

  it.skipIf(process.platform === 'win32')(
    'follows links to folders and skips broken ones',
    async () => {
      const root = tmp()
      const target = path.join(tmp(), 'real')
      mkdirSync(target)
      symlinkSync(target, path.join(root, 'linked'))
      symlinkSync(path.join(root, 'nowhere'), path.join(root, 'broken'))
      const listing = await browseFolders(root, { home: root })
      expect(listing.entries.map((e) => e.name)).toEqual(['linked'])
    },
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'explains a folder it may not open',
    async () => {
      const root = tmp()
      const locked = path.join(root, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o000)
      try {
        await expect(browseFolders(locked, { home: root })).rejects.toThrow('permission')
      } finally {
        chmodSync(locked, 0o755)
      }
    },
  )

  it('reads the branch of a linked worktree and reports a detached HEAD as a repo', async () => {
    const root = tmp()
    const main = repo(path.join(root, 'main'))
    const wt = await new GitService().createWorktree(main, { branch: 'topic' })
    expect(await readGitHead(wt.path)).toEqual({ branch: 'topic' })
    sh(main, 'checkout', '-q', '--detach')
    expect(await readGitHead(main)).toEqual({})
    expect(await readGitHead(root)).toBeNull()
  })
})

describe('crumbsOf', () => {
  it('walks from the top of the file system and marks home', () => {
    const home = path.resolve('/home/g')
    const crumbs = crumbsOf(path.join(home, 'code', 'api'), home)
    expect(crumbs.map((c) => c.name).slice(-3)).toEqual(['g', 'code', 'api'])
    expect(crumbs.find((c) => c.home)?.path).toBe(home)
    expect(crumbs[0]!.path).toBe(path.parse(home).root)
  })
})
