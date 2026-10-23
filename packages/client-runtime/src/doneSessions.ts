import type { SessionView } from './replica.ts'

/**
 * Whether a session sits in the Done section: the user filed it there, and it is not doing anything
 * (a session that runs again or needs an answer comes back out by itself).
 */
export const isFiledAway = (s: Pick<SessionView, 'done' | 'status'>): boolean =>
  s.done === true && s.status === 'idle'

/** Splits one folder's sessions into the ones shown in the list and the ones filed under Done. */
export function splitDone<T extends Pick<SessionView, 'done' | 'status'>>(
  sessions: T[],
): { active: T[]; done: T[] } {
  const active: T[] = []
  const done: T[] = []
  for (const s of sessions) (isFiledAway(s) ? done : active).push(s)
  return { active, done }
}

/** What the right-click menu offers for a session. */
export function doneMenuAction(s: Pick<SessionView, 'done' | 'status'>): {
  kind: 'file' | 'restore' | 'busy'
  label: string
  hint?: string
} {
  if (isFiledAway(s)) return { kind: 'restore', label: 'Move back to the list' }
  if (s.status === 'running') {
    return { kind: 'busy', label: 'Move to Done', hint: 'It is still working' }
  }
  if (s.status === 'needs-you') {
    return { kind: 'busy', label: 'Move to Done', hint: 'It is waiting for you' }
  }
  return { kind: 'file', label: 'Move to Done' }
}

/** Whether a folder's Done section is open: chosen by the user, or holding the open session or a search hit. */
export function doneOpen(input: {
  chosen: boolean
  searching: boolean
  activeId?: string
  done: { id: string }[]
}): boolean {
  return (
    input.chosen ||
    input.searching ||
    (input.activeId !== undefined && input.done.some((s) => s.id === input.activeId))
  )
}
