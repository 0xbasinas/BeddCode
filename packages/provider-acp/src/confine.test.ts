import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInsideFolder } from './confine.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beddcode-confine-'))
  dirs.push(d)
  return d
}

describe('isInsideFolder', () => {
  it('accepts files and not-yet-existing paths inside, and rejects outside and ..', async () => {
    const root = tmp()
    mkdirSync(path.join(root, 'a'))
    expect(await isInsideFolder(root, path.join(root, 'a', 'x.txt'))).toBe(true)
    expect(await isInsideFolder(root, path.join(root, 'new', 'deep', 'x.txt'))).toBe(true)
    expect(await isInsideFolder(root, root)).toBe(true)
    expect(await isInsideFolder(root, path.join(root, '..', 'x.txt'))).toBe(false)
    expect(await isInsideFolder(root, path.join(path.dirname(root), 'x.txt'))).toBe(false)
  })

  it('does not count a symlink that leaves the folder', async () => {
    const root = tmp()
    const other = tmp()
    try {
      symlinkSync(other, path.join(root, 'link'), 'junction')
    } catch {
      return // symlinks are not allowed on this machine
    }
    expect(await isInsideFolder(root, path.join(root, 'link', 'x.txt'))).toBe(false)
  })
})
