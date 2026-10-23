import type { GitFile } from '@beddcode/contracts'

export interface FileGroup {
  dir: string
  files: (GitFile & { name: string })[]
}

/** Groups changed files by their folder, folders and files in path order. */
export function groupByDirectory(files: GitFile[]): FileGroup[] {
  const groups = new Map<string, FileGroup>()
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const slash = file.path.lastIndexOf('/')
    const dir = slash === -1 ? '' : file.path.slice(0, slash)
    const group = groups.get(dir) ?? { dir, files: [] }
    group.files.push({ ...file, name: file.path.slice(slash + 1) })
    groups.set(dir, group)
  }
  return [...groups.values()]
}

/**
 * New (untracked) files start unchecked so a stray file is never committed by accident; anything
 * already tracked or staged starts checked.
 */
export function defaultSelected(file: GitFile): boolean {
  return file.status !== 'A' || file.staged
}

/** The paths that will be committed, given the user's explicit choices on top of the defaults. */
export function selectedPaths(files: GitFile[], overrides: Record<string, boolean>): string[] {
  return files.filter((f) => overrides[f.path] ?? defaultSelected(f)).map((f) => f.path)
}

export function commitLabel(count: number): string {
  return count === 1 ? 'Commit 1 file' : `Commit ${count} files`
}

/**
 * When an open file's diff must load again: whenever what git says about the file changes (its
 * status, staging or line counts), and whenever the pane as a whole refreshes (a turn ended, a
 * commit). Keying on the path alone kept showing the first diff after the agent edited the file
 * again.
 */
export function diffRefreshKey(file: GitFile, paneKey: string | number): string {
  return [paneKey, file.path, file.status, file.staged ? 's' : 'u', file.added, file.removed].join(
    ':',
  )
}
