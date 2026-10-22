import type { FolderCrumb, Project } from '@beddcode/contracts'

/** A folder offered under "Recent" in the Add folder menu. */
export interface RecentFolder {
  path: string
  name: string
  /** Already in the sidebar: shown greyed out with "Added". */
  added: boolean
  isRepo?: boolean
  branch?: string
}

const isWindowsPath = (p: string) => /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\')

/** Drops trailing separators (but keeps a bare root such as `/` or `C:\`). */
function trimPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  if (trimmed === '') return p.slice(0, 1)
  return /^[a-z]:$/i.test(trimmed) ? `${trimmed}\\` : trimmed
}

/** Whether two paths of the same host name the same folder (Windows paths ignore case). */
export function samePath(a: string, b: string): boolean {
  const x = trimPath(a)
  const y = trimPath(b)
  return isWindowsPath(x) || isWindowsPath(y) ? x.toLowerCase() === y.toLowerCase() : x === y
}

export function folderBaseName(p: string): string {
  return trimPath(p).split(/[\\/]/).filter(Boolean).at(-1) ?? p
}

/**
 * Folders worth offering again: ones picked before, then ones sessions ran in, then added ones.
 * Folders not yet in the sidebar come first; added ones follow, greyed out.
 */
export function recentFolders(input: {
  history: readonly string[]
  sessionPaths: readonly string[]
  projects: readonly Project[]
  limit?: number
}): RecentFolder[] {
  const seen: string[] = []
  for (const p of [...input.history, ...input.sessionPaths, ...input.projects.map((x) => x.path)]) {
    if (p && !seen.some((s) => samePath(s, p))) seen.push(p)
  }
  const rows = seen.map((p): RecentFolder => {
    const project = input.projects.find((x) => samePath(x.path, p))
    return project
      ? {
          path: project.path,
          name: project.name,
          added: true,
          isRepo: project.isRepo,
          branch: project.branch,
        }
      : { path: p, name: folderBaseName(p), added: false }
  })
  return [...rows.filter((r) => !r.added), ...rows.filter((r) => r.added)].slice(
    0,
    input.limit ?? 6,
  )
}

/** Puts a folder at the front of the picked-before list, without duplicates. */
export function rememberFolder(history: readonly string[], p: string, limit = 12): string[] {
  return [p, ...history.filter((h) => !samePath(h, p))].slice(0, limit)
}

/** Whether adding produced a new sidebar entry or found one that was already there. */
export function addOutcome(before: readonly Project[], added: Project): 'added' | 'already' {
  return before.some((p) => samePath(p.path, added.path)) ? 'already' : 'added'
}

/** `~/code/api` for a folder inside the home folder; the full path otherwise. */
export function shortPath(p: string, home?: string): string {
  if (!home) return p
  const h = trimPath(home)
  if (samePath(p, h)) return '~'
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/'
  const prefix = h + sep
  const inside = isWindowsPath(p)
    ? p.toLowerCase().startsWith(prefix.toLowerCase())
    : p.startsWith(prefix)
  return inside ? `~${sep}${p.slice(prefix.length)}` : p
}

/** Breadcrumbs from the home folder down when inside it; from the top of the disk otherwise. */
export function visibleCrumbs(crumbs: readonly FolderCrumb[]): FolderCrumb[] {
  const home = crumbs.findIndex((c) => c.home)
  return home >= 0 ? crumbs.slice(home) : [...crumbs]
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "20m ago", "2h ago", "Mon", "3 Oct": when a folder last changed, as compact as a file manager. */
export function modifiedLabel(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const date = new Date(at)
  if (now - at < 6 * 24 * 3_600_000) return WEEKDAYS[date.getDay()]!
  const label = `${date.getDate()} ${MONTHS[date.getMonth()]}`
  return new Date(now).getFullYear() === date.getFullYear()
    ? label
    : `${label} ${date.getFullYear()}`
}

/** Keys of the Browse shortcut, as shown in the menu. */
export function browseShortcut(mac: boolean): [string, string] {
  return [mac ? '⌘' : 'Ctrl', 'O']
}

/** Added folders that have no session in the list yet: they still get a sidebar group. */
export function foldersWithoutSessions<T extends { hostKey: string; project: Project }>(
  folders: readonly T[],
  sessionGroups: readonly { hostKey: string; projectPath: string }[],
): T[] {
  return folders.filter(
    (f) =>
      !sessionGroups.some(
        (g) => g.hostKey === f.hostKey && samePath(g.projectPath, f.project.path),
      ),
  )
}
