import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FileContent, FileEntry, FileMedia } from '@beddcode/contracts'
import { MediaTickets, mediaType } from './media.ts'

export const MAX_EDIT_BYTES = 2 * 1024 * 1024

/** Folders full of generated or downloaded files: shown dimmed, skipped by search. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  '.wt',
])

/** Never listed at all. */
const HIDDEN = new Set(['.git'])

export class FileError extends Error {}
export class FileConflictError extends FileError {}

const SEARCH_LIMIT = 20_000
const RESULT_LIMIT = 50

/**
 * Reads and writes files of one session folder. Every path is resolved against the folder and
 * must stay inside it (also through symlinks and junctions).
 */
export class FileService {
  /** Tickets for showing media files; the HTTP route serves what they name. */
  readonly media = new MediaTickets()

  /** Resolves `rel` inside `cwd`, or throws when it would leave it. */
  resolve(cwd: string, rel: string): string {
    let base: string
    try {
      base = realpathSync(cwd)
    } catch {
      throw new FileError(`Folder does not exist: ${cwd}`)
    }
    const target = path.resolve(base, rel)
    if (!isInside(base, target)) throw new FileError(`Path is outside the folder: ${rel}`)

    // Follow links: the nearest existing ancestor must still be inside the folder.
    let probe = target
    while (!existsSync(probe) && probe !== base) probe = path.dirname(probe)
    if (!isInside(base, realpathSync(probe)))
      throw new FileError(`Path is outside the folder: ${rel}`)
    return target
  }

  async list(cwd: string, dir = ''): Promise<FileEntry[]> {
    const target = this.resolve(cwd, dir)
    let dirents
    try {
      dirents = await readdir(target, { withFileTypes: true })
    } catch (err) {
      throw new FileError(`Cannot open folder: ${(err as Error).message}`)
    }

    const entries: FileEntry[] = []
    for (const d of dirents) {
      if (HIDDEN.has(d.name)) continue
      let isDir = d.isDirectory()
      let size: number | undefined
      if (d.isSymbolicLink()) {
        // Show links as whatever they point to; skip broken ones.
        const info = await stat(path.join(target, d.name)).catch(() => null)
        if (!info) continue
        isDir = info.isDirectory()
        size = info.isFile() ? info.size : undefined
      } else if (d.isFile()) {
        size = (await stat(path.join(target, d.name)).catch(() => null))?.size
      }
      entries.push({
        name: d.name,
        type: isDir ? 'dir' : 'file',
        size,
        ignored: isDir && IGNORED_DIRS.has(d.name) ? true : undefined,
      })
    }
    return entries.sort(
      (a, b) =>
        (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }

  async read(cwd: string, rel: string): Promise<FileContent> {
    const file = this.resolve(cwd, rel)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) throw new FileError(`Not a file: ${rel}`)
    const base = { path: toPosix(rel), mtime: info.mtimeMs, size: info.size }
    if (info.size > MAX_EDIT_BYTES) return { ...base, content: '', binary: false, tooLarge: true }

    const buf = await readFile(file)
    if (buf.subarray(0, 8000).includes(0))
      return { ...base, content: '', binary: true, tooLarge: false }
    const text = buf.toString('utf8')
    return {
      ...base,
      content: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
      binary: false,
      tooLarge: false,
    }
  }

  /** A ticketed address for an image, video or audio file, or null for any other file. */
  async mediaFor(cwd: string, rel: string): Promise<FileMedia | null> {
    const type = mediaType(rel)
    if (!type) return null
    const file = this.resolve(cwd, rel)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) throw new FileError(`Not a file: ${rel}`)
    return {
      url: `/media/${this.media.issue(file, type.mime)}`,
      kind: type.kind,
      mime: type.mime,
      size: info.size,
      mtime: info.mtimeMs,
    }
  }

  /** Saves a file. When `expectedMtime` is given, a newer version on disk is never overwritten. */
  async write(cwd: string, rel: string, content: string, expectedMtime?: number): Promise<number> {
    const file = this.resolve(cwd, rel)
    const current = await stat(file).catch(() => null)
    if (current && !current.isFile()) throw new FileError(`Not a file: ${rel}`)
    if (current && expectedMtime !== undefined && Math.abs(current.mtimeMs - expectedMtime) > 1) {
      throw new FileConflictError('The file changed on disk since you opened it')
    }
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content, 'utf8')
    return (await stat(file)).mtimeMs
  }

  async create(cwd: string, rel: string, type: 'file' | 'dir'): Promise<void> {
    const target = this.resolve(cwd, rel)
    if (existsSync(target)) throw new FileError(`Already exists: ${rel}`)
    if (type === 'dir') await mkdir(target, { recursive: true })
    else {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, '', { flag: 'wx' })
    }
  }

  /** Files whose path contains every word of the query, best matches first. */
  async search(cwd: string, query: string): Promise<string[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    const base = this.resolve(cwd, '')

    const found: { path: string; score: number }[] = []
    let visited = 0
    const queue = ['']
    while (queue.length > 0 && visited < SEARCH_LIMIT) {
      const dir = queue.shift()!
      const dirents = await readdir(path.join(base, dir), { withFileTypes: true }).catch(() => [])
      for (const d of dirents) {
        if (HIDDEN.has(d.name) || (d.isDirectory() && IGNORED_DIRS.has(d.name))) continue
        visited++
        const rel = dir ? `${dir}/${d.name}` : d.name
        if (d.isDirectory()) {
          queue.push(rel)
          continue
        }
        const lower = rel.toLowerCase()
        if (!words.every((w) => lower.includes(w))) continue
        const name = d.name.toLowerCase()
        // Name matches beat folder matches; earlier and shorter beats later and longer.
        const score =
          (words.every((w) => name.includes(w)) ? 0 : 1000) +
          (name.startsWith(words[0]!) ? 0 : 100) +
          rel.length
        found.push({ path: rel, score })
      }
    }
    return found
      .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
      .slice(0, RESULT_LIMIT)
      .map((f) => f.path)
  }
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const toPosix = (p: string) => p.replace(/\\/g, '/')
