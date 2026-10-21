import path from 'node:path'

/**
 * A path as the UI shows it: relative to the session folder when it lives inside it, otherwise
 * unchanged. Forward slashes on every platform so transcripts read the same everywhere.
 */
export function displayPath(file: string, cwd: string | undefined): string {
  if (!cwd) return file
  const rel = path.relative(cwd, file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    ? rel.split(path.sep).join('/')
    : file
}
