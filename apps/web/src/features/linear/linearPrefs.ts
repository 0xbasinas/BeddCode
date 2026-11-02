/** What the Linear page remembers on this device, and how it filters, groups and sorts issues. */

export type GroupBy = 'state' | 'priority' | 'assignee' | 'project' | 'none'
export type SortBy = 'updated' | 'priority' | 'due'

export interface Display {
  groupBy: GroupBy
  sortBy: SortBy
  showLabels: boolean
}

export interface Filters {
  priorities: number[]
  assignee: 'any' | 'me' | 'none'
  label: string
  project: string
  overdue: boolean
}

/** Used for new issues, and the one thing the host does in Linear by itself. */
export interface Defaults {
  teamId: string
  projectId: string
  assignee: 'me' | 'none'
  /** File a Linear issue when a scheduled task fails (kept by the host; this is the last choice made). */
  fileFailedRuns: boolean
}

export const DEFAULT_DISPLAY: Display = { groupBy: 'state', sortBy: 'updated', showLabels: true }
export const NO_FILTERS: Filters = {
  priorities: [],
  assignee: 'any',
  label: '',
  project: '',
  overdue: false,
}
export const DEFAULT_DEFAULTS: Defaults = {
  teamId: '',
  projectId: '',
  assignee: 'none',
  fileFailedRuns: false,
}

const DISPLAY_KEY = 'beddcode.linear-display'
const DEFAULTS_KEY = 'beddcode.linear-defaults'

function read<T extends object>(key: string, fallback: T): T {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<T> | null
    return saved && typeof saved === 'object' ? { ...fallback, ...saved } : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: object) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Still works for this window.
  }
}

export const readDisplay = () => read(DISPLAY_KEY, DEFAULT_DISPLAY)
export const writeDisplay = (d: Display) => write(DISPLAY_KEY, d)
export const readDefaults = () => read(DEFAULTS_KEY, DEFAULT_DEFAULTS)
export const writeDefaults = (d: Defaults) => write(DEFAULTS_KEY, d)

/** The fields of an issue that filtering, grouping and sorting look at. */
export interface Sortable {
  state: string
  stateType: string
  priority: number
  priorityLabel: string
  assignee: string
  project: string
  labels: string[]
  dueDate?: string
  updatedAt: Date
}

const startOfToday = () => new Date(new Date().toDateString())
export const isOverdue = (r: Pick<Sortable, 'dueDate'>) =>
  Boolean(r.dueDate && new Date(r.dueDate) < startOfToday())

export function activeFilterCount(f: Filters): number {
  return (
    (f.priorities.length ? 1 : 0) +
    (f.assignee !== 'any' ? 1 : 0) +
    (f.label ? 1 : 0) +
    (f.project ? 1 : 0) +
    (f.overdue ? 1 : 0)
  )
}

/** `me` is the viewer's display name, as issues name their assignee. */
export function applyFilters<T extends Sortable>(rows: T[], f: Filters, me: string): T[] {
  return rows.filter(
    (r) =>
      (f.priorities.length === 0 || f.priorities.includes(r.priority)) &&
      (f.assignee === 'any' || (f.assignee === 'me' ? r.assignee === me : r.assignee === '')) &&
      (!f.label || r.labels.includes(f.label)) &&
      (!f.project || r.project === f.project) &&
      (!f.overdue || isOverdue(r)),
  )
}

/** Linear's order of urgency: urgent, high, medium, low, then none. */
const priorityRank = (p: number) => (p === 0 ? 5 : p)
/** Where each kind of status sits: what is being worked on first, what is done last. */
const STATE_RANK: Record<string, number> = {
  started: 0,
  unstarted: 1,
  backlog: 2,
  triage: 3,
  completed: 4,
  canceled: 5,
}

export function sortRows<T extends Sortable>(rows: T[], by: SortBy): T[] {
  const copy = [...rows]
  if (by === 'priority')
    return copy.sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        b.updatedAt.getTime() - a.updatedAt.getTime(),
    )
  if (by === 'due')
    return copy.sort(
      (a, b) =>
        (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
        b.updatedAt.getTime() - a.updatedAt.getTime(),
    )
  return copy.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}

export interface Group<T> {
  key: string
  label: string
  /** For a status group: its kind and colour, so the heading can show the status icon. */
  state?: { type: string; color: string }
  rows: T[]
}

export function groupRows<T extends Sortable & { stateColor?: string }>(
  rows: T[],
  by: GroupBy,
  sort: SortBy,
): Group<T>[] {
  const sorted = sortRows(rows, sort)
  if (by === 'none') return sorted.length ? [{ key: 'all', label: 'All issues', rows: sorted }] : []
  const keyOf = (r: T) =>
    by === 'state'
      ? r.state
      : by === 'priority'
        ? r.priorityLabel
        : by === 'assignee'
          ? r.assignee || 'Unassigned'
          : r.project || 'No project'
  const groups = new Map<string, Group<T>>()
  for (const r of sorted) {
    const key = keyOf(r)
    const group = groups.get(key)
    if (group) group.rows.push(r)
    else
      groups.set(key, {
        key,
        label: key,
        state: by === 'state' ? { type: r.stateType, color: r.stateColor ?? '' } : undefined,
        rows: [r],
      })
  }
  const list = [...groups.values()]
  if (by === 'state')
    list.sort((a, b) => (STATE_RANK[a.state!.type] ?? 9) - (STATE_RANK[b.state!.type] ?? 9))
  if (by === 'priority')
    list.sort((a, b) => priorityRank(a.rows[0]!.priority) - priorityRank(b.rows[0]!.priority))
  return list
}
