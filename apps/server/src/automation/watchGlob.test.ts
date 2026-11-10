import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { filesDigest, globToRegExp, scanGlob } from './watchGlob.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('globToRegExp', () => {
  it('matches * within one segment and ** across folders', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false)
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/deep/a.ts')).toBe(false)
    expect(globToRegExp('src/**/*.ts').test('src/deep/a.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('lib/a.ts')).toBe(false)
    expect(globToRegExp('**/*.test.ts').test('a/b/c.test.ts')).toBe(true)
  })

  it('supports ? and escapes regex characters', () => {
    expect(globToRegExp('a?c.ts').test('abc.ts')).toBe(true)
    expect(globToRegExp('a?c.ts').test('a/c.ts')).toBe(false)
    expect(globToRegExp('file (1).ts').test('file (1).ts')).toBe(true)
    expect(globToRegExp('file (1).ts').test('file 1.ts')).toBe(false)
    expect(globToRegExp('a+b.ts').test('a+b.ts')).toBe(true)
  })
})

describe('scanGlob', () => {
  it('lists matching files with sizes and mtimes, skipping heavy folders', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-glob-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true })
    mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'a')
    writeFileSync(path.join(dir, 'src', 'deep', 'b.ts'), 'bb')
    writeFileSync(path.join(dir, 'src', 'c.md'), 'ccc')
    writeFileSync(path.join(dir, 'node_modules', 'pkg', 'd.ts'), 'dddd')

    const all = await scanGlob(dir, '**/*.ts')
    expect(all.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/deep/b.ts'])
    expect(all.find((f) => f.path === 'src/deep/b.ts')!.size).toBe(2)

    const rootOnly = await scanGlob(dir, '*.ts')
    expect(rootOnly).toEqual([])
  })
})

describe('filesDigest', () => {
  it('changes when a file changes and not when nothing does', () => {
    const a = filesDigest([{ path: 'a.ts', size: 1, mtimeMs: 1000 }])
    const same = filesDigest([{ path: 'a.ts', size: 1, mtimeMs: 1000 }])
    const reordered = filesDigest([
      { path: 'b.ts', size: 2, mtimeMs: 2000 },
      { path: 'a.ts', size: 1, mtimeMs: 1000 },
    ])
    const b = filesDigest([
      { path: 'a.ts', size: 1, mtimeMs: 1000 },
      { path: 'b.ts', size: 2, mtimeMs: 2000 },
    ])
    expect(a).toBe(same)
    expect(reordered).toBe(b)
    expect(filesDigest([{ path: 'a.ts', size: 2, mtimeMs: 1000 }])).not.toBe(a)
  })
})
