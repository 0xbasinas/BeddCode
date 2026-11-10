import { realpath } from 'node:fs/promises'
import path from 'node:path'

const caseless = process.platform === 'win32' || process.platform === 'darwin'
const norm = (p: string) => (caseless ? p.toLowerCase() : p)

/** The real location of a path that may not exist yet: its nearest existing parent, resolved. */
async function resolveReal(file: string): Promise<string> {
  const rest: string[] = []
  let current = path.resolve(file)
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(file)
      rest.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * Whether `file` lies inside `root` once symlinks are followed, so a link in the folder that points
 * elsewhere does not count as inside. The file need not exist. This is what keeps an agent's file
 * writes (`fs/write_text_file`) in the session folder, as acpx does for its client filesystem.
 */
export async function isInsideFolder(root: string, file: string): Promise<boolean> {
  const [realRoot, realFile] = await Promise.all([resolveReal(root), resolveReal(file)])
  const relative = path.relative(norm(realRoot), norm(realFile))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
