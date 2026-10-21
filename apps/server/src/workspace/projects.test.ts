import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from './git.ts'
import { ProjectStore } from './projects.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beddcode-proj-')))
  dirs.push(d)
  return d
}
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true })

function repo() {
  const dir = tmp()
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'T')
  sh(dir, 'config', 'user.email', 't@e.com')
  writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

describe('ProjectStore', () => {
  it('stores folders, describes git state live, and ignores duplicates', async () => {
    const store = new ProjectStore(path.join(tmp(), 'projects.json'), new GitService())
    expect(await store.list()).toEqual([])

    const dir = repo()
    const plain = tmp()
    const added = await store.add(dir)
    await store.add(dir)
    await store.add(plain)

    expect(added).toMatchObject({
      path: dir,
      name: path.basename(dir),
      isRepo: true,
      branch: 'main',
    })
    const listed = await store.list()
    expect(listed.map((p) => [p.path, p.isRepo])).toEqual([
      [dir, true],
      [plain, false],
    ])
  })

  it('stores the main checkout when given a subfolder or a worktree', async () => {
    const store = new ProjectStore(path.join(tmp(), 'projects.json'), new GitService())
    const dir = repo()
    mkdirSync(path.join(dir, 'sub'))
    expect((await store.add(path.join(dir, 'sub'))).path).toBe(dir)

    const wt = await new GitService().createWorktree(dir, { branch: 'topic' })
    expect((await store.add(wt.path)).path).toBe(dir)
    expect(await store.list()).toHaveLength(1)
  })

  it('removes a project and rejects a missing folder', async () => {
    const store = new ProjectStore(path.join(tmp(), 'projects.json'), new GitService())
    const dir = repo()
    await store.add(dir)
    expect(store.remove(dir)).toBe(true)
    expect(store.remove(dir)).toBe(false)
    await expect(store.add(path.join(tmp(), 'missing'))).rejects.toThrow('does not exist')
  })
})
