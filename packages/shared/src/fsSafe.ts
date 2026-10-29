import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

let tmpCounter = 0

/** Blocks for a few milliseconds without spinning the CPU. */
function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Replaces `file` with `data` so that a crash, a kill or a full disk leaves either the old file or
 * the new one, never half of one: write to a temporary file next to it, flush it to disk, then
 * rename it over the original. The temporary name is unique, so the host and a CLI writing the
 * same file at once cannot interleave. On Windows a rename can briefly fail while an indexer or an
 * antivirus holds the file open, so it is tried a few times.
 */
export function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'w', options.mode ?? 0o666)
    const buf = typeof data === 'string' ? Buffer.from(data) : data
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    try {
      fsyncSync(fd)
    } catch {
      // Some file systems (network shares, some containers) do not support fsync.
    }
    closeSync(fd)
    fd = undefined
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file)
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
        pause(20 * (attempt + 1))
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // already failed
      }
    }
    rmSync(tmp, { force: true })
    throw err
  }
}

export type ReadJsonResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  /** The file could not be parsed; it was moved aside to `quarantined` (when that worked). */
  | { status: 'corrupt'; quarantined?: string; error: string }

/**
 * Reads a JSON file that may have been damaged (a crash in an older version, a full disk, a hand
 * edit). A file that does not parse is renamed to `<file>.corrupt-<time>` so it is kept for the
 * user to inspect, and the caller starts from defaults instead of failing to start, or silently
 * overwriting the only copy at its next save.
 */
export function readJsonFile<T = unknown>(file: string): ReadJsonResult<T> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    // Unreadable (permissions, a directory): leave it where it is.
    return { status: 'corrupt', error: err instanceof Error ? err.message : String(err) }
  }
  try {
    // A file cut off at zero bytes is the most common leftover of a crash mid-write.
    if (!text.trim()) throw new Error('the file is empty')
    return { status: 'ok', value: JSON.parse(text) as T }
  } catch (err) {
    return {
      status: 'corrupt',
      quarantined: quarantineFile(file),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Moves a damaged file aside, keeping it; returns the new path, or undefined if it could not. */
export function quarantineFile(file: string): string | undefined {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.corrupt-${stamp}`
  try {
    renameSync(file, target)
    return target
  } catch {
    return undefined
  }
}
