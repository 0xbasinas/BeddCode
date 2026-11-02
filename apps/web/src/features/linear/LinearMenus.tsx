import { ListFilter, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  activeFilterCount,
  NO_FILTERS,
  type Display,
  type Filters,
  type GroupBy,
  type SortBy,
} from './linearPrefs.ts'

const PRIORITIES: [number, string][] = [
  [1, 'Urgent'],
  [2, 'High'],
  [3, 'Medium'],
  [4, 'Low'],
  [0, 'None'],
]

/** A row of choices of which exactly one is on. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: [T, string][]
  onChange(value: T): void
}) {
  return (
    <div className="lin-pop-group">
      <span>{label}</span>
      <div className="lin-pop-chips" role="group" aria-label={label}>
        {options.map(([id, text]) => (
          <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

export function FilterMenu({
  filters,
  labels,
  projects,
  onChange,
}: {
  filters: Filters
  /** The labels and projects of the issues on screen. */
  labels: string[]
  projects: string[]
  onChange(filters: Filters): void
}) {
  const count = activeFilterCount(filters)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="app" className="settings-button" aria-label="Filter issues">
          <ListFilter size={13} /> Filter {count > 0 && <span className="lin-badge">{count}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="lin-pop">
        <div className="lin-pop-group">
          <span>Priority</span>
          <div className="lin-pop-chips" role="group" aria-label="Priority">
            {PRIORITIES.map(([p, text]) => (
              <button
                key={p}
                type="button"
                aria-pressed={filters.priorities.includes(p)}
                onClick={() =>
                  onChange({
                    ...filters,
                    priorities: filters.priorities.includes(p)
                      ? filters.priorities.filter((x) => x !== p)
                      : [...filters.priorities, p],
                  })
                }
              >
                {text}
              </button>
            ))}
          </div>
        </div>
        <Choice
          label="Assignee"
          value={filters.assignee}
          options={[
            ['any', 'Anyone'],
            ['me', 'Me'],
            ['none', 'Unassigned'],
          ]}
          onChange={(assignee) => onChange({ ...filters, assignee })}
        />
        {labels.length > 0 && (
          <Choice
            label="Label"
            value={filters.label}
            options={[['', 'Any'], ...labels.map((l): [string, string] => [l, l])]}
            onChange={(label) => onChange({ ...filters, label })}
          />
        )}
        {projects.length > 0 && (
          <Choice
            label="Project"
            value={filters.project}
            options={[['', 'Any'], ...projects.map((p): [string, string] => [p, p])]}
            onChange={(project) => onChange({ ...filters, project })}
          />
        )}
        <label className="lin-pop-check">
          <input
            type="checkbox"
            checked={filters.overdue}
            onChange={(e) => onChange({ ...filters, overdue: e.target.checked })}
          />
          Overdue only
        </label>
        {count > 0 && (
          <Button variant="app" className="settings-button" onClick={() => onChange(NO_FILTERS)}>
            Clear filters
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function DisplayMenu({
  display,
  onChange,
}: {
  display: Display
  onChange(display: Display): void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="app" className="settings-button" aria-label="Display options">
          <SlidersHorizontal size={13} /> Display
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="lin-pop">
        <Choice<GroupBy>
          label="Group by"
          value={display.groupBy}
          options={[
            ['state', 'Status'],
            ['priority', 'Priority'],
            ['assignee', 'Assignee'],
            ['project', 'Project'],
            ['none', 'None'],
          ]}
          onChange={(groupBy) => onChange({ ...display, groupBy })}
        />
        <Choice<SortBy>
          label="Order by"
          value={display.sortBy}
          options={[
            ['updated', 'Last updated'],
            ['priority', 'Priority'],
            ['due', 'Due date'],
          ]}
          onChange={(sortBy) => onChange({ ...display, sortBy })}
        />
        <label className="lin-pop-check">
          <input
            type="checkbox"
            checked={display.showLabels}
            onChange={(e) => onChange({ ...display, showLabels: e.target.checked })}
          />
          Show labels
        </label>
      </PopoverContent>
    </Popover>
  )
}
