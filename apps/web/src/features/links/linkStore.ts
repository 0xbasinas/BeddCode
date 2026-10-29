import { create } from 'zustand'
import { hostRequest } from '../../stores/host.ts'

export interface Located {
  /** The path relative to the session folder. */
  path: string
  type: 'file' | 'dir'
}

/** What the host said about each path: a place in the folder, null for none, absent while asked. */
export const useLinkStore = create<{ found: Record<string, Located | null> }>(() => ({ found: {} }))

export const linkKey = (hostKey: string, cwd: string, path: string) =>
  `${hostKey}\u0000${cwd}\u0000${path}`

const BATCH = 200
const queued = new Map<string, { hostKey: string; cwd: string; paths: Set<string> }>()
const asked = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined

/** Asks the host, once and in batches, whether `path` names something inside `cwd`. */
export function locate(hostKey: string, cwd: string, path: string) {
  const key = linkKey(hostKey, cwd, path)
  if (asked.has(key)) return
  asked.add(key)
  const group = `${hostKey}\u0000${cwd}`
  const entry = queued.get(group) ?? { hostKey, cwd, paths: new Set<string>() }
  entry.paths.add(path)
  queued.set(group, entry)
  timer ??= setTimeout(flush, 30)
}

function flush() {
  timer = undefined
  const groups = [...queued.values()]
  queued.clear()
  for (const { hostKey, cwd, paths } of groups) {
    const all = [...paths]
    for (let i = 0; i < all.length; i += BATCH) {
      const batch = all.slice(i, i + BATCH)
      void hostRequest(hostKey, 'files.locate', { cwd, paths: batch })
        .then(({ found }) => settle(hostKey, cwd, batch, found))
        .catch(() => {
          // An older host, or no connection: plain text, and ask again later.
          settle(hostKey, cwd, batch, [])
          for (const p of batch) asked.delete(linkKey(hostKey, cwd, p))
        })
    }
  }
}

function settle(hostKey: string, cwd: string, paths: string[], found: (Located | null)[]) {
  useLinkStore.setState((s) => {
    const next = { ...s.found }
    paths.forEach((p, i) => (next[linkKey(hostKey, cwd, p)] = found[i] ?? null))
    return { found: next }
  })
}
