import type { SessionView } from './replica.ts'

/** One line saying what the session is doing right now, like the rows in the designs. */
export function activityLine(s: SessionView): string {
  const last = s.items.findLast(
    (i) => i.kind === 'tool' || i.kind === 'approval' || i.kind === 'error',
  )
  switch (s.status) {
    case 'needs-you':
      return last?.kind === 'approval'
        ? `Wants: ${last.title.replace(/\?$/, '')}`
        : 'Needs your answer'
    case 'running':
      return last?.kind === 'tool' ? last.title : 'Working…'
    case 'failed':
      return last?.kind === 'error' ? last.message : 'Failed'
    case 'idle':
      if (s.lastTurnReason === 'cancelled') return 'Stopped · ready to continue'
      return s.items.length === 0
        ? 'No messages yet'
        : s.added + s.removed > 0
          ? 'Done · changes ready'
          : 'Done'
  }
}

/**
 * What to say next to the branch and agent: only what is worth a word. A finished session says
 * nothing (its check mark and change counts already do), a busy one says what it is doing.
 */
export function sessionNote(s: SessionView): string {
  if (s.status === 'idle') {
    if (s.lastTurnReason === 'cancelled') return 'Stopped'
    return s.items.length === 0 ? 'New' : ''
  }
  return activityLine(s)
}
