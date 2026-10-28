import type { FileEntry } from '@beddcode/contracts'
import { hostRequest } from '../../stores/host.ts'

export interface MentionItem {
  /** Relative to the working folder, with `/` separators. */
  path: string
  name: string
  dir: boolean
  size?: number
}

const LIMIT = 40

/** A folder's entries, folders first, leaving out build output and dependencies. */
export function browseItems(dir: string, entries: FileEntry[], filter = ''): MentionItem[] {
  const needle = filter.toLowerCase()
  return entries
    .filter((e) => !e.ignored && e.name.toLowerCase().includes(needle))
    .map((e) => ({ path: `${dir}${e.name}`, name: e.name, dir: e.type === 'dir', size: e.size }))
    .sort(
      (a, b) =>
        Number(b.dir) - Number(a.dir) ||
        Number(b.name.toLowerCase().startsWith(needle)) -
          Number(a.name.toLowerCase().startsWith(needle)) ||
        a.name.localeCompare(b.name),
    )
}

/**
 * What an `@query` offers: a folder's contents for an empty query or one ending in `/`, otherwise
 * the matching folders next to the files found anywhere below.
 */
export async function mentionItems(
  hostKey: string,
  cwd: string,
  query: string,
): Promise<MentionItem[]> {
  const slash = query.lastIndexOf('/')
  const dir = query.slice(0, slash + 1)
  const rest = query.slice(slash + 1)
  const list = (d: string) =>
    hostRequest(hostKey, 'files.list', { cwd, dir: d ? d.replace(/\/$/, '') : undefined }).then(
      (r) => r.entries,
      () => [] as FileEntry[],
    )
  if (!rest) return browseItems(dir, await list(dir)).slice(0, LIMIT)
  const [entries, found] = await Promise.all([
    list(dir),
    hostRequest(hostKey, 'files.search', { cwd, query }).then(
      (r) => r.paths,
      () => [] as string[],
    ),
  ])
  const folders = browseItems(dir, entries, rest).filter((i) => i.dir)
  const files = found
    .filter((p) => !folders.some((f) => f.path === p))
    .map((p) => ({ path: p, name: p.split('/').pop() ?? p, dir: false }))
  return [...folders, ...files].slice(0, LIMIT)
}
