import { describe, expect, it } from 'vitest'
import {
  activeFilterCount,
  applyFilters,
  groupRows,
  NO_FILTERS,
  sortRows,
  type Sortable,
} from './linearPrefs.ts'

const row = (over: Partial<Sortable> & { id: string }): Sortable & { id: string } => ({
  state: 'Todo',
  stateType: 'unstarted',
  priority: 0,
  priorityLabel: 'No priority',
  assignee: '',
  project: '',
  labels: [],
  updatedAt: new Date(2026, 0, 1),
  ...over,
})

const rows = [
  row({ id: 'a', state: 'Backlog', stateType: 'backlog', priority: 4, priorityLabel: 'Low' }),
  row({
    id: 'b',
    state: 'In Progress',
    stateType: 'started',
    priority: 2,
    priorityLabel: 'High',
    assignee: 'Georgios',
    labels: ['Bug'],
    project: 'Scheduled tasks',
    dueDate: '2000-01-01',
    updatedAt: new Date(2026, 0, 3),
  }),
  row({
    id: 'c',
    state: 'Todo',
    priority: 1,
    priorityLabel: 'Urgent',
    labels: ['Feature'],
    updatedAt: new Date(2026, 0, 2),
  }),
]

describe('linear filters', () => {
  it('narrows by priority, assignee, label, project and overdue', () => {
    expect(
      applyFilters(rows, { ...NO_FILTERS, priorities: [1, 2] }, 'Georgios').map((r) => r.id),
    ).toEqual(['b', 'c'])
    expect(
      applyFilters(rows, { ...NO_FILTERS, assignee: 'me' }, 'Georgios').map((r) => r.id),
    ).toEqual(['b'])
    expect(
      applyFilters(rows, { ...NO_FILTERS, assignee: 'none' }, 'Georgios').map((r) => r.id),
    ).toEqual(['a', 'c'])
    expect(applyFilters(rows, { ...NO_FILTERS, label: 'Feature' }, '').map((r) => r.id)).toEqual([
      'c',
    ])
    expect(
      applyFilters(rows, { ...NO_FILTERS, project: 'Scheduled tasks' }, '').map((r) => r.id),
    ).toEqual(['b'])
    expect(applyFilters(rows, { ...NO_FILTERS, overdue: true }, '').map((r) => r.id)).toEqual(['b'])
    expect(activeFilterCount({ ...NO_FILTERS, priorities: [1], overdue: true })).toBe(2)
  })
})

describe('linear grouping and sorting', () => {
  it('puts what is being worked on first when grouping by status', () => {
    const groups = groupRows(rows, 'state', 'updated')
    expect(groups.map((g) => g.label)).toEqual(['In Progress', 'Todo', 'Backlog'])
    expect(groups[0]!.state?.type).toBe('started')
  })

  it('groups by priority from urgent down, and by assignee', () => {
    expect(groupRows(rows, 'priority', 'updated').map((g) => g.label)).toEqual([
      'Urgent',
      'High',
      'Low',
    ])
    expect(
      groupRows(rows, 'assignee', 'updated')
        .map((g) => g.label)
        .sort(),
    ).toEqual(['Georgios', 'Unassigned'])
    expect(groupRows(rows, 'none', 'updated')).toHaveLength(1)
    expect(groupRows([], 'none', 'updated')).toEqual([])
  })

  it('sorts by update, priority or due date', () => {
    expect(sortRows(rows, 'updated').map((r) => r.id)).toEqual(['b', 'c', 'a'])
    expect(sortRows(rows, 'priority').map((r) => r.id)).toEqual(['c', 'b', 'a'])
    expect(sortRows(rows, 'due').map((r) => r.id)[0]).toBe('b')
  })
})
