import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { SKIP_DIRS } from '../telemetry/hostMetrics.ts'

/** One file a watch trigger saw: enough to tell a change from a no-op. */
export interface WatchedFile {
  /** Path relative to the watched folder, with `/` separators. */
  path: string
  size: number
  mtimeMs: number
}

/** Never walk more than this many entries, so a huge tree cannot stall a tick. */
const SCAN_CAP = 20_000

/**
 * Turns a glob into a RegExp matched against `/`-separated relative paths. `**` crosses folder
 * boundaries, `*` and `?` stay within one segment, and a leading `/` anchors at the root (the
 * default, so `*.ts` does not match `src/a.ts`).
 */
export function globToRegExp(glob: string): RegExp {
  const text = glob.trim().replace(/^\/+/, '')
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '*') {
      if (text[i + 1] === '*') {
        // `**/` also matches zero folders, so `a/**/b` matches `a/b` too.
        if (text[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/** Lists the files under `cwd` that match `glob`, relative paths, capped at {@link SCAN_CAP}. */
export async function scanGlob(cwd: string, glob: string): Promise<WatchedFile[]> {
  const match = globToRegExp(glob)
  const found: WatchedFile[] = []
  let seen = 0
  const walk = async (dir: string, rel: string) => {
    if (seen > SCAN_CAP) return
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (++seen > SCAN_CAP) return
      const full = path.join(dir, entry)
      const relPath = rel ? `${rel}/${entry}` : entry
      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) await walk(full, relPath)
      } else if (info.isFile() && match.test(relPath)) {
        found.push({ path: relPath, size: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
  await walk(cwd, '')
  return found
}

/** A short, stable digest of a file list, so only real changes fire a watch trigger. */
export function filesDigest(files: WatchedFile[]): string {
  const hash = createHash('sha256')
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path)))
    hash.update(`${f.path}:${f.size}:${Math.round(f.mtimeMs)}\n`)
  return hash.digest('hex')
}
