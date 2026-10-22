import { readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FolderCrumb, FolderEntry, FolderListing } from '@beddcode/contracts'

/** More than anyone scrolls through; the rest is left out and the listing says so. */
export const MAX_FOLDERS = 500

export class FolderBrowseError extends Error {}

export interface BrowseOptions {
  /** List folders whose name starts with a dot. Off by default. */
  showHidden?: boolean
  /** Overrides the home folder (tests). */
  home?: string
}

/**
 * Lists the subfolders of a folder on this machine, for picking a project on a host the user's
 * own system picker cannot reach. Only folder names and git branches are returned, never files or
 * their contents, and nothing is written.
 */
export async function browseFolders(
  folder: string | undefined,
  options: BrowseOptions = {},
): Promise<FolderListing> {
  const home = path.resolve(options.home ?? os.homedir())
  if (folder !== undefined && !path.isAbsolute(folder)) {
    throw new FolderBrowseError(`Not an absolute path: ${folder}`)
  }
  const target = path.resolve(folder ?? home)

  let info
  try {
    info = await stat(target)
  } catch (err) {
    throw new FolderBrowseError(explain(err, target))
  }
  if (!info.isDirectory()) throw new FolderBrowseError(`Not a folder: ${target}`)

  let dirents
  try {
    dirents = await readdir(target, { withFileTypes: true })
  } catch (err) {
    throw new FolderBrowseError(explain(err, target))
  }

  const candidates = dirents
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .filter((d) => options.showHidden || !d.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))

  const entries: FolderEntry[] = []
  let truncated = false
  for (const d of candidates) {
    if (entries.length >= MAX_FOLDERS) {
      truncated = true
      break
    }
    const full = path.join(target, d.name)
    // Links count as whatever they point to; broken links and links to files are skipped.
    const s = await stat(full).catch(() => null)
    if (!s?.isDirectory()) continue
    const git = await readGitHead(full)
    entries.push({
      name: d.name,
      path: full,
      isRepo: git !== null,
      branch: git?.branch,
      modifiedAt: Math.round(s.mtimeMs),
    })
  }

  const parent = path.dirname(target)
  return {
    path: target,
    parent: parent === target ? null : parent,
    home,
    crumbs: crumbsOf(target, home),
    entries,
    truncated,
  }
}

/** The chain of folders from the top of the file system down to `folder`. */
export function crumbsOf(folder: string, home: string): FolderCrumb[] {
  const out: FolderCrumb[] = []
  let current = path.resolve(folder)
  for (;;) {
    const parent = path.dirname(current)
    const name = parent === current ? current : path.basename(current)
    out.unshift(
      samePath(current, home) ? { name, path: current, home: true } : { name, path: current },
    )
    if (parent === current) break
    current = parent
  }
  return out
}

/**
 * Whether a folder is the top of a git repository, and its branch, read straight from `.git`
 * so listing a folder of many repositories does not start a `git` process per entry.
 */
export async function readGitHead(folder: string): Promise<{ branch?: string } | null> {
  const dotGit = path.join(folder, '.git')
  const s = await stat(dotGit).catch(() => null)
  if (!s) return null
  let gitDir = dotGit
  if (s.isFile()) {
    // Linked worktrees and submodules: `.git` is a file that points at the real directory.
    const pointer = await readFile(dotGit, 'utf8').catch(() => '')
    const match = /^gitdir:\s*(.+)$/m.exec(pointer)
    if (!match) return null
    gitDir = path.resolve(folder, match[1]!.trim())
  }
  const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => null)
  if (head === null) return null
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)
  return ref ? { branch: ref[1]!.trim() } : {}
}

function explain(err: unknown, target: string): string {
  switch ((err as NodeJS.ErrnoException).code) {
    case 'ENOENT':
      return `Folder does not exist: ${target}`
    case 'EACCES':
    case 'EPERM':
      return `You don't have permission to open ${target}`
    case 'ENOTDIR':
      return `Not a folder: ${target}`
    default:
      return `Cannot open ${target}: ${err instanceof Error ? err.message : String(err)}`
  }
}

function samePath(a: string, b: string) {
  // Windows paths are case-insensitive; elsewhere they are not.
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
