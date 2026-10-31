import type { SessionView } from '@beddcode/client-runtime'

export type ActivityWindow = 'any' | 'today' | 'week' | 'month'

/** Narrowing of the session list beyond the All / Needs you / Done tabs. */
export interface SessionFilters {
  statuses: SessionView['status'][]
  /** Project keys (`<host>\n<path>`); empty means every project. */
  projects: string[]
  /** Only sessions active within this window. */
  since: ActivityWindow
  pinnedOnly: boolean
  worktreeOnly: boolean
}

export const NO_FILTERS: SessionFilters = {
  statuses: [],
  projects: [],
  since: 'any',
  pinnedOnly: false,
  worktreeOnly: false,
}

export const STATUS_LABELS: Record<SessionView['status'], string> = {
  'needs-you': 'Needs you',
  running: 'Running',
  failed: 'Failed',
  idle: 'Idle',
}

export const WINDOW_LABELS: Record<ActivityWindow, string> = {
  any: 'Any time',
  today: 'Today',
  week: 'Past 7 days',
  month: 'Past 30 days',
}

const DAY = 24 * 60 * 60 * 1000

export function activeFilterCount(f: SessionFilters): number {
  return (
    f.statuses.length +
    f.projects.length +
    (f.since !== 'any' ? 1 : 0) +
    (f.pinnedOnly ? 1 : 0) +
    (f.worktreeOnly ? 1 : 0)
  )
}

/** When the activity window opens, or 0 for any time. */
function windowStart(since: ActivityWindow, now: number): number {
  switch (since) {
    case 'today': {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }
    case 'week':
      return now - 7 * DAY
    case 'month':
      return now - 30 * DAY
    default:
      return 0
  }
}

export function matchesFilters(
  s: Pick<SessionView, 'status' | 'updatedAt' | 'pinned' | 'worktree'>,
  projectKey: string,
  f: SessionFilters,
  now = Date.now(),
): boolean {
  if (f.statuses.length && !f.statuses.includes(s.status)) return false
  if (f.projects.length && !f.projects.includes(projectKey)) return false
  if (f.pinnedOnly && !s.pinned) return false
  if (f.worktreeOnly && !s.worktree) return false
  return s.updatedAt >= windowStart(f.since, now)
}

/** Toggle one value in a list, keeping the others. */
export const toggled = <T>(list: T[], value: T): T[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
