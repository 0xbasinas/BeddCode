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
import { GitService } from './git.ts'
import { copyWorktreeIncludes } from './worktreeInclude.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })

function repo(files: Record<string, string>) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-wti-')))
  dirs.push(dir)
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'Test User')
  sh(dir, 'config', 'user.email', 'test@example.com')
  sh(dir, 'config', 'commit.gpgsign', 'false')
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), text)
  }
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-q', '-m', 'initial')
  return dir
}

describe('copyWorktreeIncludes', () => {
  it('does nothing without a .worktreeinclude file', async () => {
    const dir = repo({ 'a.txt': 'a\n', '.gitignore': '.env\n' })
    writeFileSync(path.join(dir, '.env'), 'SECRET=1\n')
    const wt = await new GitService().createWorktree(dir, { branch: 'plain' })
    expect(wt.copiedFiles).toBeUndefined()
    expect(existsSync(path.join(wt.path, '.env'))).toBe(false)
  })

  it('copies ignored files the include file lists into a new worktree, nothing else', async () => {
    const dir = repo({
      'a.txt': 'a\n',
      '.gitignore': '.env*\nnode_modules/\nlocal/\n',
      '.worktreeinclude': '.env*\nconfig/*.local.json\nlocal/\n',
      'config/app.json': '{}\n',
    })
    writeFileSync(path.join(dir, '.env'), 'TOKEN=main\n')
    writeFileSync(path.join(dir, '.env.local'), 'X=1\n')
    mkdirSync(path.join(dir, 'local', 'deep'), { recursive: true })
    writeFileSync(path.join(dir, 'local', 'deep', 'notes.txt'), 'n\n')
    // Listed but not ignored by git: an untracked file is the agent's to create, not ours.
    writeFileSync(path.join(dir, 'config', 'dev.local.json'), '{"untracked":true}\n')
    // Ignored but not listed.
    mkdirSync(path.join(dir, 'node_modules'))
    writeFileSync(path.join(dir, 'node_modules', 'big.js'), '//\n')

    const wt = await new GitService().createWorktree(dir, { branch: 'with-env' })
    expect(wt.copiedFiles).toBe(3)
    expect(readFileSync(path.join(wt.path, '.env'), 'utf8')).toBe('TOKEN=main\n')
    expect(existsSync(path.join(wt.path, '.env.local'))).toBe(true)
    expect(existsSync(path.join(wt.path, 'local', 'deep', 'notes.txt'))).toBe(true)
    expect(existsSync(path.join(wt.path, 'config', 'dev.local.json'))).toBe(false)
    expect(existsSync(path.join(wt.path, 'node_modules'))).toBe(false)
  })

  it('keeps files that already exist in the worktree', async () => {
    const dir = repo({ 'a.txt': 'a\n', '.gitignore': '.env\n', '.worktreeinclude': '.env\n' })
    writeFileSync(path.join(dir, '.env'), 'FROM=main\n')
    const wt = path.join(dir, '..', path.basename(dir) + '-wt')
    dirs.push(wt)
    sh(dir, 'worktree', 'add', '-q', '-b', 'side', wt)
    writeFileSync(path.join(wt, '.env'), 'FROM=worktree\n')
    const result = await copyWorktreeIncludes(wt, dir)
    expect(result).toMatchObject({ kind: 'copied', copied: [], skipped: ['.env'] })
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('FROM=worktree\n')
  })

  it('reports no files when nothing listed is present', async () => {
    const dir = repo({ 'a.txt': 'a\n', '.gitignore': '.env\n', '.worktreeinclude': '.env\n' })
    const result = await copyWorktreeIncludes(dir, dir)
    expect(result).toEqual({
      kind: 'copied',
      copied: [],
      skipped: [],
      failed: [],
      truncated: false,
    })
  })
})
