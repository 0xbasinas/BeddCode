import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileConflictError, FileError, FileService, MAX_EDIT_BYTES } from './files.ts'
import { FileWatchers } from './watcher.ts'
import { MAX_ATTACHMENT_BYTES } from '../attachments/store.ts'

const dirs: string[] = []
afterEach(() =>
  dirs
    .splice(0)
    .forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
)
const tmp = () => {
  const d = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-files-')))
  dirs.push(d)
  return d
}
const files = new FileService()

describe('FileService.readAttachment', () => {
  it('reads binary bytes and files larger than the editor limit without decoding', async () => {
    const cwd = tmp()
    const data = Buffer.alloc(MAX_EDIT_BYTES + 5, 0x89)
    writeFileSync(path.join(cwd, 'image.png'), data)
    expect(await files.readAttachment(cwd, 'image.png')).toEqual(data)
    writeFileSync(path.join(cwd, 'empty.txt'), '')
    expect(await files.readAttachment(cwd, 'empty.txt')).toEqual(Buffer.alloc(0))
  })

  it('rejects directories, missing files, oversize files and paths outside the workspace', async () => {
    const cwd = tmp()
    writeFileSync(path.join(cwd, 'large.bin'), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))
    await expect(files.readAttachment(cwd, 'large.bin')).rejects.toThrow('larger than 20 MB')
    await expect(files.readAttachment(cwd, '')).rejects.toThrow()
    await expect(files.readAttachment(cwd, 'missing.txt')).rejects.toThrow()
    await expect(files.readAttachment(cwd, '../outside')).rejects.toThrow('outside the folder')
    const outside = tmp()
    writeFileSync(path.join(outside, 'secret'), 'secret')
    try {
      symlinkSync(outside, path.join(cwd, 'escape'), 'junction')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return
      throw err
    }
    await expect(files.readAttachment(cwd, 'escape/secret')).rejects.toThrow('outside the folder')
  })
})

/** A small project: src/, test/, node_modules/, .git/ and a few root files. */
function project() {
  const dir = tmp()
  for (const d of ['src/limiter', 'test', 'node_modules/dep', '.git'])
    mkdirSync(path.join(dir, d), { recursive: true })
  writeFileSync(path.join(dir, 'src/limiter/token-bucket.ts'), 'export const a = 1\n')
  writeFileSync(path.join(dir, 'src/limiter/index.ts'), 'export {}\n')
  writeFileSync(path.join(dir, 'test/failover.test.ts'), 'test\n')
  writeFileSync(path.join(dir, 'node_modules/dep/index.js'), 'x')
  writeFileSync(path.join(dir, 'README.md'), '# hi\n')
  writeFileSync(path.join(dir, '.gitignore'), 'dist\n')
  return dir
}

describe('FileService.list', () => {
  it('invalidates indexed search paths after creates and watcher notifications', async () => {
    const dir = project()
    expect(await files.search(dir, 'fresh')).toEqual([])
    await files.create(dir, 'fresh.ts', 'file')
    expect(await files.search(dir, 'fresh')).toEqual(['fresh.ts'])
    writeFileSync(path.join(dir, 'fresh-external.ts'), '')
    files.invalidate(dir)
    expect(await files.search(dir, 'external')).toEqual(['fresh-external.ts'])
    if (process.platform === 'win32') {
      await files.create(dir.toUpperCase(), 'mixed-case.ts', 'file')
      expect(await files.search(dir, 'mixed-case')).toEqual(['mixed-case.ts'])
    }
  })

  it('lists folders first, hides .git, and dims dependency folders', async () => {
    const dir = project()
    const root = await files.list(dir)
    expect(root.map((e) => `${e.type}:${e.name}`)).toEqual([
      'dir:node_modules',
      'dir:src',
      'dir:test',
      'file:.gitignore',
      'file:README.md',
    ])
    expect(root.find((e) => e.name === 'node_modules')?.ignored).toBe(true)
    expect(root.find((e) => e.name === 'src')?.ignored).toBeUndefined()
    expect(root.find((e) => e.name === 'README.md')?.size).toBe(5)
  })

  it('lists a subfolder', async () => {
    const entries = await files.list(project(), 'src/limiter')
    expect(entries.map((e) => e.name)).toEqual(['index.ts', 'token-bucket.ts'])
  })

  it('refuses to leave the folder', async () => {
    const dir = project()
    await expect(files.list(dir, '..')).rejects.toBeInstanceOf(FileError)
    await expect(files.read(dir, '../outside.txt')).rejects.toThrow('outside the folder')
    await expect(files.read(dir, path.resolve(dir, '..', 'x'))).rejects.toThrow(
      'outside the folder',
    )
  })

  it('refuses to follow a link out of the folder', async () => {
    const dir = project()
    const outside = tmp()
    writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    try {
      symlinkSync(outside, path.join(dir, 'escape'), 'junction')
    } catch {
      return // links not permitted on this machine
    }
    await expect(files.read(dir, 'escape/secret.txt')).rejects.toThrow('outside the folder')
    await expect(files.write(dir, 'escape/new.txt', 'x')).rejects.toThrow('outside the folder')
  })
})

describe('FileService.read and write', () => {
  it('reads text, strips a byte-order mark and reports mtime and size', async () => {
    const dir = project()
    writeFileSync(path.join(dir, 'bom.txt'), '﻿hello')
    const f = await files.read(dir, 'bom.txt')
    expect(f).toMatchObject({ path: 'bom.txt', content: 'hello', binary: false, tooLarge: false })
    expect(f.mtime).toBeGreaterThan(0)
  })

  it('does not load binary or oversized files', async () => {
    const dir = project()
    writeFileSync(path.join(dir, 'img.bin'), Buffer.from([1, 2, 0, 3]))
    expect(await files.read(dir, 'img.bin')).toMatchObject({ binary: true, content: '' })
    writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(MAX_EDIT_BYTES + 1))
    expect(await files.read(dir, 'big.txt')).toMatchObject({ tooLarge: true, content: '' })
    await expect(files.read(dir, 'src')).rejects.toThrow('Not a file')
    await expect(files.read(dir, 'missing.txt')).rejects.toThrow('Not a file')
  })

  it('saves and returns the new mtime', async () => {
    const dir = project()
    const before = await files.read(dir, 'README.md')
    const mtime = await files.write(dir, 'README.md', '# changed\n', before.mtime)
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# changed\n')
    expect(mtime).toBeGreaterThanOrEqual(before.mtime)
  })

  it('refuses to overwrite a file that changed on disk since it was opened', async () => {
    const dir = project()
    const opened = await files.read(dir, 'README.md')
    const later = new Date(opened.mtime + 5000)
    writeFileSync(path.join(dir, 'README.md'), 'edited elsewhere')
    utimesSync(path.join(dir, 'README.md'), later, later)
    await expect(files.write(dir, 'README.md', 'mine', opened.mtime)).rejects.toBeInstanceOf(
      FileConflictError,
    )
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('edited elsewhere')
    // Without an expected time the caller explicitly overwrites.
    await files.write(dir, 'README.md', 'forced')
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('forced')
  })

  it('creates files and folders, including missing parents, but never overwrites', async () => {
    const dir = project()
    await files.create(dir, 'src/new/deep.ts', 'file')
    await files.create(dir, 'docs/guide', 'dir')
    expect(readFileSync(path.join(dir, 'src/new/deep.ts'), 'utf8')).toBe('')
    expect((await files.list(dir, 'docs')).map((e) => e.name)).toEqual(['guide'])
    await expect(files.create(dir, 'README.md', 'file')).rejects.toThrow('Already exists')
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# hi\n')
  })

  it('writes new files inside new folders', async () => {
    const dir = project()
    await files.write(dir, 'a/b/c.txt', 'deep')
    expect(readFileSync(path.join(dir, 'a/b/c.txt'), 'utf8')).toBe('deep')
  })
})

describe('FileService.search', () => {
  it('finds files by name or path words, name matches first, skipping dependencies', async () => {
    const dir = project()
    writeFileSync(path.join(dir, 'src/limiter/limits.ts'), '')
    expect(await files.search(dir, 'token')).toEqual(['src/limiter/token-bucket.ts'])
    expect(await files.search(dir, 'limiter index')).toEqual(['src/limiter/index.ts'])
    expect(await files.search(dir, 'index')).toEqual(['src/limiter/index.ts'])
    expect((await files.search(dir, 'limit'))[0]).toBe('src/limiter/limits.ts')
    expect(await files.search(dir, 'nothing-matches')).toEqual([])
    expect(await files.search(dir, '   ')).toEqual([])
  })
})

describe('FileWatchers', () => {
  it('reports changes under a folder in one debounced burst, and stops after the last listener', async () => {
    const dir = project()
    const watchers = new FileWatchers()
    const bursts: string[][] = []
    const release = watchers.acquire(dir, (paths) => bursts.push(paths))
    await new Promise((r) => setTimeout(r, 500)) // let the watcher settle

    writeFileSync(path.join(dir, 'src/limiter/new.ts'), 'a')
    writeFileSync(path.join(dir, 'src/limiter/new2.ts'), 'b')
    const start = Date.now()
    while (!bursts.flat().includes('src/limiter/new2.ts') && Date.now() - start < 6000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(bursts.flat()).toEqual(
      expect.arrayContaining(['src/limiter/new.ts', 'src/limiter/new2.ts']),
    )

    // Dependency folders are not watched.
    const count = bursts.flat().length
    writeFileSync(path.join(dir, 'node_modules/dep/other.js'), 'x')
    await new Promise((r) => setTimeout(r, 700))
    expect(bursts.flat().length).toBe(count)

    release()
    await watchers.closeAll()
  })
})

describe('FileService.locate', () => {
  it('finds files and folders inside the folder, relative or absolute, and nothing outside', async () => {
    const cwd = tmp()
    const outside = tmp()
    mkdirSync(path.join(cwd, 'src'))
    writeFileSync(path.join(cwd, 'src', 'math.ts'), 'x')
    writeFileSync(path.join(outside, 'secret.txt'), 'x')
    symlinkSync(outside, path.join(cwd, 'escape'), 'junction')
    expect(
      await files.locate(cwd, [
        'src/math.ts',
        './src/math.ts',
        path.join(cwd, 'src', 'math.ts'),
        'src',
        'missing.ts',
        '../x.ts',
        path.join(outside, 'secret.txt'),
        'escape/secret.txt',
      ]),
    ).toEqual([
      { path: 'src/math.ts', type: 'file' },
      { path: 'src/math.ts', type: 'file' },
      { path: 'src/math.ts', type: 'file' },
      { path: 'src', type: 'dir' },
      null,
      null,
      null,
      null,
    ])
  })

  it('answers nothing for a folder that is gone', async () => {
    expect(await files.locate(path.join(os.tmpdir(), 'beddcode-no-such-dir'), ['a.ts'])).toEqual([
      null,
    ])
  })
})
