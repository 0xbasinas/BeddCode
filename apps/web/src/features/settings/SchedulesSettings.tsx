import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Link } from '@tanstack/react-router'
import {
  CalendarClock,
  ChevronLeft,
  Clock,
  Info,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type { Schedule, ScheduleRun } from '@beddcode/contracts'
import { hostRequest, readyProviders, useAllSessions, useRuntime } from '../../stores/host.ts'
import { folderName, timeAgo } from '../../ui/format.ts'
import { Select } from '../../ui/Select.tsx'
import {
  DAY_NAMES,
  describeTrigger,
  emptyScheduleForm,
  formToInput,
  formTrigger,
  runLabel,
  scheduleToForm,
  summaryLine,
  type ScheduleForm,
} from './scheduleForm.ts'
import '../schedules/schedules.css'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
const when = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  })
const dayAndTime = (at: number, timeZone?: string) => ({
  day: new Date(at).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }),
  time: new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }),
})

/** "47 min", "2h 14m", "4d 7h": how long until a time. */
function until(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

type Health = 'success' | 'failed' | 'running' | 'paused' | 'idle' | 'stopped'
const HEALTH_LABEL: Record<Health, string> = {
  success: 'Success',
  failed: 'Failed',
  running: 'Running',
  paused: 'Paused',
  idle: 'Never run',
  stopped: 'Stopped',
}

function lastRun(runs: ScheduleRun[]): ScheduleRun | undefined {
  return runs.reduce<ScheduleRun | undefined>(
    (best, r) => (!best || r.startedAt > best.startedAt ? r : best),
    undefined,
  )
}

function healthOf(s: Schedule, runs: ScheduleRun[]): Health {
  if (s.paused) return 'paused'
  const last = lastRun(runs.filter((r) => r.status !== 'skipped'))
  if (!last) return 'idle'
  if (last.status === 'running') return 'running'
  if (last.status === 'done') return 'success'
  if (last.status === 'error') return 'failed'
  return 'stopped'
}

const targetLabel = (s: Schedule) =>
  s.target.kind === 'session' ? 'Heartbeat to a session' : `New ${s.target.instanceId} session`

type Filter = 'all' | 'active' | 'paused' | 'failed'

/** Prompts one host runs on a timer, whether or not any app is open. */
export function SchedulesSettings({
  hostKey,
  hostPicker,
}: {
  hostKey: string
  hostPicker?: ReactNode
}) {
  const { connection, epoch } = useRuntime(hostKey)
  const online = connection === 'connected'
  const [data, setData] = useState<{ schedules: Schedule[]; runs: ScheduleRun[] }>()
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<ScheduleForm>()
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string>()

  const load = useCallback(async () => {
    if (!online) return
    try {
      setData(await hostRequest(hostKey, 'schedules.list', {}))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [hostKey, online])

  useEffect(() => {
    void load()
    // Runs start and end on the host's clock; keep the list fresh while it is on screen.
    const timer = setInterval(() => void load(), 5_000)
    return () => clearInterval(timer)
  }, [load, epoch])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const schedules = data?.schedules ?? []
  const runsOf = useCallback(
    (id: string) => (data?.runs ?? []).filter((r) => r.scheduleId === id),
    [data],
  )
  const health = useMemo(
    () => new Map(schedules.map((s) => [s.id, healthOf(s, runsOf(s.id))])),
    [schedules, runsOf],
  )
  const counts = {
    all: schedules.length,
    active: schedules.filter((s) => !s.paused).length,
    paused: schedules.filter((s) => s.paused).length,
    failed: schedules.filter((s) => health.get(s.id) === 'failed').length,
  }
  const shown = schedules.filter((s) => {
    if (filter === 'active' && s.paused) return false
    if (filter === 'paused' && !s.paused) return false
    if (filter === 'failed' && health.get(s.id) !== 'failed') return false
    const text = query.trim().toLowerCase()
    return !text || `${s.name} ${s.prompt}`.toLowerCase().includes(text)
  })
  const selected = schedules.find((s) => s.id === selectedId) ?? shown[0]

  // The cards on top: what is on, what is next, how the week went, what needs a look.
  const now = Date.now()
  const weekRuns = (data?.runs ?? []).filter(
    (r) => r.startedAt > now - 7 * 86_400_000 && r.status !== 'skipped' && r.status !== 'running',
  )
  const succeeded = weekRuns.filter((r) => r.status === 'done').length
  const nextUp = schedules
    .filter((s) => !s.paused && s.nextRunAt)
    .sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0]

  if (editing) {
    return (
      <ScheduleEditor
        hostKey={hostKey}
        form={editing}
        busy={busy}
        error={error}
        onChange={setEditing}
        onCancel={() => setEditing(undefined)}
        onSave={(input) =>
          run(async () => {
            const saved = await hostRequest(hostKey, 'schedules.save', input)
            setSelectedId(saved.id)
            setEditing(undefined)
          })
        }
        onRemove={
          editing.id
            ? () =>
                run(async () => {
                  await hostRequest(hostKey, 'schedules.remove', { id: editing.id! })
                  setSelectedId(undefined)
                  setEditing(undefined)
                })
            : undefined
        }
      />
    )
  }

  return (
    <>
      <header className="sch-head">
        <div>
          <h2>Scheduled tasks</h2>
          <p>Agents that run on their own, on a timer. Review results the next time you open it.</p>
        </div>
        <div className="sch-head-actions">
          {hostPicker}
          <Button
            variant="app"
            className="settings-button primary"
            disabled={!online || busy}
            onClick={() => setEditing(emptyScheduleForm())}
          >
            <Plus size={14} /> New task
          </Button>
        </div>
      </header>
      {!online && (
        <p className="settings-notice" role="status">
          Connect to this host to see its schedules.
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      <div className="sch-stats">
        <Stat label="Active">
          <b>{counts.active}</b>
          <span>of {counts.all} tasks</span>
        </Stat>
        <Stat label="Next run">
          {nextUp ? (
            <>
              <b>{until(nextUp.nextRunAt!, now)}</b>
              <span>{nextUp.name}</span>
            </>
          ) : (
            <span>Nothing scheduled</span>
          )}
        </Stat>
        <Stat label="Runs this week">
          <b>{weekRuns.length}</b>
          {weekRuns.length > 0 && (
            <span className="ok">{Math.round((succeeded / weekRuns.length) * 100)}% succeeded</span>
          )}
        </Stat>
        <Stat label="Needs attention">
          <b className={counts.failed ? 'bad' : ''}>{counts.failed}</b>
          <span>failed {counts.failed === 1 ? 'run' : 'runs'}</span>
        </Stat>
      </div>

      <div className="sch-toolbar">
        <div className="sch-tabs" role="tablist" aria-label="Filter tasks">
          {(['all', 'active', 'paused', 'failed'] as const).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
              {f[0]!.toUpperCase() + f.slice(1)} <span>{counts[f]}</span>
            </button>
          ))}
        </div>
        <label className="sch-search">
          <Search size={14} />
          <input
            aria-label="Filter tasks"
            placeholder="Filter tasks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      <div className="sch-split">
        <div className="sch-list">
          {data && shown.length === 0 && (
            <p className="settings-empty">
              {schedules.length === 0
                ? 'No scheduled tasks yet. A task sends a prompt on a timer: a fresh session each time, or a heartbeat to one you already have.'
                : 'No tasks match this filter.'}
            </p>
          )}
          {shown.map((s) => {
            const h = health.get(s.id)!
            return (
              <div
                key={s.id}
                className={`sch-row ${selected?.id === s.id ? 'selected' : ''} ${s.paused ? 'paused' : ''}`}
              >
                <button
                  className="sch-row-main"
                  aria-pressed={selected?.id === s.id}
                  onClick={() => setSelectedId(s.id)}
                >
                  <span className="sch-icon">
                    <CalendarClock size={16} />
                  </span>
                  <span className="sch-name">
                    <strong>{s.name}</strong>
                    <small title={s.prompt}>{s.prompt}</small>
                  </span>
                  <span className="sch-when">
                    <span>
                      <Clock size={12} /> {describeTrigger(s.trigger)}
                    </span>
                    <small>
                      {s.paused
                        ? 'Paused'
                        : s.nextRunAt
                          ? `Next in ${until(s.nextRunAt, now)}`
                          : 'Never fires'}
                    </small>
                  </span>
                  <span className={`sch-pill ${h}`}>{HEALTH_LABEL[h]}</span>
                </button>
                <Switch
                  aria-label={s.paused ? `Resume ${s.name}` : `Pause ${s.name}`}
                  checked={!s.paused}
                  disabled={!online || busy}
                  onCheckedChange={(on) =>
                    void run(() =>
                      hostRequest(hostKey, 'schedules.setPaused', { id: s.id, paused: !on }),
                    )
                  }
                />
              </div>
            )
          })}
        </div>

        {selected && (
          <ScheduleDetail
            schedule={selected}
            runs={runsOf(selected.id)}
            health={health.get(selected.id)!}
            disabled={!online || busy}
            onEdit={() => setEditing(scheduleToForm(selected))}
            onRunNow={() =>
              run(() => hostRequest(hostKey, 'schedules.runNow', { id: selected.id }))
            }
            onSkipNext={() =>
              run(() => hostRequest(hostKey, 'schedules.skipNext', { id: selected.id }))
            }
          />
        )}
      </div>
      <p className="settings-footnote">
        Tasks run on the host in its own time zone, even with every app closed. A run is skipped
        while the previous one is still going, and missed runs are not made up after the host was
        off. Turn on “A scheduled run finishes” in phone alerts to hear about each run.
      </p>
    </>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sch-stat">
      <span className="sch-stat-label">{label}</span>
      <div className="sch-stat-value">{children}</div>
    </div>
  )
}

function ScheduleDetail({
  schedule: s,
  runs,
  health,
  disabled,
  onEdit,
  onRunNow,
  onSkipNext,
}: {
  schedule: Schedule
  runs: ScheduleRun[]
  health: Health
  disabled: boolean
  onEdit(): void
  onRunNow(): void
  onSkipNext(): void
}) {
  const recent = [...runs].sort((a, b) => b.startedAt - a.startedAt)
  const failed = health === 'failed' ? recent.find((r) => r.status === 'error') : undefined
  return (
    <aside className="sch-detail" aria-label={`${s.name} details`}>
      <div className="sch-detail-head">
        <span className="sch-icon">
          <CalendarClock size={16} />
        </span>
        <div>
          <strong>{s.name}</strong>
          <small>{describeTrigger(s.trigger)}</small>
        </div>
      </div>
      {failed && (
        <div className="sch-alert" role="alert">
          <TriangleAlert size={14} />
          <div>
            <strong>Last run failed {timeAgo(failed.startedAt)} ago</strong>
            {failed.note && <code>{failed.note}</code>}
          </div>
        </div>
      )}
      <dl className="sch-facts">
        <div>
          <dt>Prompt</dt>
          <dd className="sch-prompt" title={s.prompt}>
            {s.prompt}
          </dd>
        </div>
        <div>
          <dt>Runs as</dt>
          <dd>{targetLabel(s)}</dd>
        </div>
        {s.target.kind === 'new' && s.target.cwd && (
          <div>
            <dt>Folder</dt>
            <dd className="mono">
              {folderName(s.target.cwd)}
              {s.target.worktree ? ' (worktree)' : ''}
            </dd>
          </div>
        )}
        {s.target.kind === 'new' && s.target.model && (
          <div>
            <dt>Model</dt>
            <dd>{s.target.model}</dd>
          </div>
        )}
        {s.trigger.kind === 'cron' && (
          <div>
            <dt>Timezone</dt>
            <dd>{s.trigger.timezone ?? 'Host’s time zone'}</dd>
          </div>
        )}
        <div>
          <dt>Notify on</dt>
          <dd>
            {{ always: 'Every run', failure: 'Failure only', never: 'Never' }[s.notify ?? 'always']}
          </dd>
        </div>
        {(s.retryOnFailure || s.openPr) && (
          <div>
            <dt>Options</dt>
            <dd>
              {[s.openPr && 'Opens a PR', s.retryOnFailure && 'Retries once']
                .filter(Boolean)
                .join(' · ')}
            </dd>
          </div>
        )}
        <div>
          <dt>Next run</dt>
          <dd>{s.paused ? 'Paused' : s.nextRunAt ? when(s.nextRunAt) : 'Never'}</dd>
        </div>
      </dl>
      <h4 className="sch-section">Run history</h4>
      <p className="sch-muted">Test runs do not change the next scheduled run.</p>
      {recent.length === 0 ? (
        <p className="sch-muted">No runs yet.</p>
      ) : (
        <ol className="sch-runs" aria-label={`Recent runs of ${s.name}`}>
          {recent.map((r) => (
            <li key={r.id}>
              <span
                className={`dot ${r.status === 'running' ? 'running' : r.status === 'done' ? 'ok' : r.status === 'skipped' ? '' : 'warn'}`}
              />
              <span>{when(r.startedAt)}</span>
              <span className="sch-muted" title={r.note}>
                {runLabel(r)}
                {r.manual ? ' · test run' : ''}
                {r.endedAt !== undefined
                  ? ` · ${Math.max(0, Math.round((r.endedAt - r.startedAt) / 1000))}s`
                  : ''}
              </span>
              {r.sessionId && (
                <Link to="/session/$sessionId" params={{ sessionId: r.sessionId }}>
                  Open
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="sch-detail-actions">
        <Button
          variant="app"
          className="settings-button primary"
          disabled={disabled}
          onClick={onRunNow}
        >
          <Play size={13} /> Run test now
        </Button>
        <Button
          variant="app"
          className="settings-button"
          disabled={disabled || s.paused || !s.nextRunAt}
          onClick={onSkipNext}
        >
          Skip next run
        </Button>
        <Button variant="app" className="settings-button" disabled={disabled} onClick={onEdit}>
          <Pencil size={13} /> Edit
        </Button>
      </div>
    </aside>
  )
}

const REPEATS: [ScheduleForm['repeat'], string][] = [
  ['every', 'Interval'],
  ['hourly', 'Hourly'],
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['cron', 'Custom cron'],
  ['watch', 'On file change'],
]

/** The zones the editor offers: the browser's own and every one the runtime knows. */
const ZONES: string[] = (() => {
  try {
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone
    const all = (
      Intl as unknown as { supportedValuesOf?(k: string): string[] }
    ).supportedValuesOf?.('timeZone')
    return [...new Set([own, ...(all ?? [])])].filter(Boolean).sort()
  } catch {
    return []
  }
})()

/** One switch with a title and a line of explanation, as the editor's setting rows. */
function ToggleRow({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string
  hint: string
  checked: boolean
  onChange(value: boolean): void
}) {
  return (
    <div className="sch-toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
      <Switch aria-label={title} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function ScheduleEditor({
  hostKey,
  form,
  busy,
  error,
  onChange,
  onCancel,
  onSave,
  onRemove,
}: {
  hostKey: string
  form: ScheduleForm
  busy: boolean
  error?: string
  onChange(form: ScheduleForm): void
  onCancel(): void
  onSave(input: Parameters<typeof hostRequest<'schedules.save'>>[2]): void
  onRemove?(): void
}) {
  const { providers, projects } = useRuntime(hostKey)
  const agents = readyProviders(providers)
  const sessions = useAllSessions().filter((h) => h.hostKey === hostKey)
  const [problem, setProblem] = useState<string>()
  const [preview, setPreview] = useState<{ times: number[]; error?: string }>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = (patch: Partial<ScheduleForm>) => onChange({ ...form, ...patch })
  const agent = agents.find((a) => a.id === form.instanceId)
  const canWorktree = projects.some((p) => p.path === form.cwd && p.isRepo)

  useEffect(() => {
    if (!form.instanceId && agents[0]) onChange({ ...form, instanceId: agents[0].id })
  }, [agents, form, onChange])

  // Shows the next few times as the trigger is typed.
  const trigger = formTrigger(form)
  const triggerKey = JSON.stringify(trigger)
  useEffect(() => {
    const parsed = JSON.parse(triggerKey) as ReturnType<typeof formTrigger>
    if ('error' in parsed) return setPreview({ times: [], error: parsed.error })
    let live = true
    const timer = setTimeout(() => {
      void hostRequest(hostKey, 'schedules.preview', { trigger: parsed, count: 4 }).then(
        (p) => live && setPreview(p),
        (err: unknown) => live && setPreview({ times: [], error: errorMessage(err) }),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [hostKey, triggerKey])

  const submit = () => {
    const result = formToInput(form)
    if ('error' in result) return setProblem(result.error)
    setProblem(undefined)
    onSave(result.input)
  }

  return (
    <form
      className="sch-editor"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <button type="button" className="sch-back" onClick={onCancel}>
        <ChevronLeft size={14} /> Scheduled tasks
      </button>
      <header className="sch-head">
        <div>
          <h2>{form.id ? 'Edit scheduled task' : 'New scheduled task'}</h2>
          <p>Describe what the agent should do and when it should run.</p>
        </div>
      </header>

      <div className="sch-editor-grid">
        <div className="sch-editor-main">
          <h3 className="sch-group">Details</h3>
          <section className="sch-card">
            <label className="sch-field">
              <span>Name</span>
              <input
                autoFocus
                value={form.name}
                placeholder="Daily dependency audit"
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <label className="sch-field">
              <span>
                Instructions <em>Markdown supported</em>
              </span>
              <textarea
                rows={5}
                value={form.prompt}
                placeholder="Scan every lockfile in the repo and open a single PR that bumps outdated packages."
                onChange={(e) => set({ prompt: e.target.value })}
              />
            </label>
          </section>

          <h3 className="sch-group">Schedule</h3>
          <section className="sch-card">
            <div className="sch-field">
              <span>Repeat</span>
              <div className="sch-segment" role="group" aria-label="Repeat">
                {REPEATS.map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={form.repeat === kind}
                    onClick={() => set({ repeat: kind })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {form.repeat === 'weekly' && (
              <div className="sch-field">
                <span>On these days</span>
                <div className="sch-days" role="group" aria-label="Days of the week">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={form.days.includes(d)}
                      onClick={() =>
                        set({
                          days: form.days.includes(d)
                            ? form.days.filter((x) => x !== d)
                            : [...form.days, d],
                        })
                      }
                    >
                      {DAY_NAMES[d]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {form.repeat === 'monthly' && (
              <label className="sch-field">
                <span>On day of the month</span>
                <input
                  inputMode="numeric"
                  value={form.monthDay}
                  onChange={(e) => set({ monthDay: e.target.value })}
                />
              </label>
            )}
            {form.repeat === 'every' && (
              <label className="sch-field">
                <span>Minutes between runs</span>
                <input
                  inputMode="numeric"
                  value={form.minutes}
                  onChange={(e) => set({ minutes: e.target.value })}
                />
              </label>
            )}
            {form.repeat === 'cron' && (
              <label className="sch-field">
                <span>Cron expression</span>
                <input
                  className="mono"
                  value={form.expr}
                  placeholder="0 9 * * 1-5"
                  onChange={(e) => set({ expr: e.target.value })}
                />
              </label>
            )}
            {form.repeat === 'watch' && (
              <>
                <label className="sch-field">
                  <span>Glob to watch (under the folder)</span>
                  <input
                    className="mono"
                    value={form.glob}
                    placeholder={'src/**/*.ts'}
                    onChange={(e) => set({ glob: e.target.value })}
                  />
                </label>
                <label className="sch-field">
                  <span>Minutes before it can fire again</span>
                  <input
                    inputMode="numeric"
                    value={form.debounceMinutes}
                    onChange={(e) => set({ debounceMinutes: e.target.value })}
                  />
                </label>
              </>
            )}
            {form.repeat !== 'every' && form.repeat !== 'watch' && (
              <div className="sch-two">
                {form.repeat === 'hourly' ? (
                  <label className="sch-field">
                    <span>At minute</span>
                    <input
                      inputMode="numeric"
                      value={form.minuteOfHour}
                      onChange={(e) => set({ minuteOfHour: e.target.value })}
                    />
                  </label>
                ) : form.repeat !== 'cron' ? (
                  <label className="sch-field">
                    <span>At</span>
                    <span className="sch-clock">
                      <Clock size={14} />
                      <input
                        type="time"
                        value={form.time}
                        onChange={(e) => set({ time: e.target.value })}
                      />
                    </span>
                  </label>
                ) : null}
                <div className="sch-field">
                  <span>Timezone</span>
                  <Select
                    aria-label="Timezone"
                    value={form.timezone}
                    onChange={(e) => set({ timezone: e.target.value })}
                  >
                    <option value="">The host’s time zone</option>
                    {ZONES.map((z) => (
                      <option key={z} value={z}>
                        {z}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            )}
            {!('error' in trigger) && trigger.kind === 'cron' && (
              <p className="sch-cron">
                <span>cron</span> {trigger.expr}
              </p>
            )}
            {preview?.error && (
              <p className="sch-hint error" role="status">
                {preview.error}
              </p>
            )}
          </section>

          <h3 className="sch-group">Run settings</h3>
          <section className="sch-card">
            <div className="sch-field">
              <span>Each run</span>
              <div className="sch-segment" role="group" aria-label="Each run">
                {(
                  [
                    ['new', 'Starts a fresh session'],
                    ['session', 'Heartbeat to a session'],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={form.targetKind === kind}
                    onClick={() => set({ targetKind: kind })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {form.targetKind === 'session' ? (
              <div className="sch-field">
                <span>Session</span>
                <Select value={form.sessionId} onChange={(e) => set({ sessionId: e.target.value })}>
                  <option value="">Choose a session…</option>
                  {sessions.map(({ session }) => (
                    <option key={session.id} value={session.id}>
                      {session.title || 'Untitled'}
                    </option>
                  ))}
                </Select>
              </div>
            ) : (
              <>
                <div className="sch-two">
                  <div className="sch-field">
                    <span>Agent</span>
                    <Select
                      value={form.instanceId}
                      onChange={(e) =>
                        set({ instanceId: e.target.value, model: '', permissionMode: '' })
                      }
                    >
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="sch-field">
                    <span>Folder</span>
                    <Select value={form.cwd} onChange={(e) => set({ cwd: e.target.value })}>
                      <option value="">No project</option>
                      {projects.map((p) => (
                        <option key={p.path} value={p.path}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                {((agent?.capabilities.models?.length ?? 0) > 0 ||
                  (agent?.capabilities.permissionModes.length ?? 0) > 0) && (
                  <div className="sch-two">
                    {(agent?.capabilities.models?.length ?? 0) > 0 && (
                      <div className="sch-field">
                        <span>Model</span>
                        <Select value={form.model} onChange={(e) => set({ model: e.target.value })}>
                          <option value="">Agent default</option>
                          {agent!.capabilities.models!.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                    {(agent?.capabilities.permissionModes.length ?? 0) > 0 && (
                      <div className="sch-field">
                        <span>Permissions</span>
                        <Select
                          value={form.permissionMode}
                          onChange={(e) => set({ permissionMode: e.target.value })}
                        >
                          <option value="">Agent default</option>
                          {agent!.capabilities.permissionModes.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                  </div>
                )}
                {canWorktree && (
                  <ToggleRow
                    title="A new worktree for each run"
                    hint="Each run works in its own checkout of the repository"
                    checked={form.worktree}
                    onChange={(worktree) => set({ worktree })}
                  />
                )}
                <ToggleRow
                  title="Open a pull request with changes"
                  hint="Work happens on a new branch, never on main"
                  checked={form.openPr}
                  onChange={(openPr) => set({ openPr })}
                />
              </>
            )}
            <ToggleRow
              title="Retry once on failure"
              hint="Wait 10 minutes, then run again before reporting"
              checked={form.retryOnFailure}
              onChange={(retryOnFailure) => set({ retryOnFailure })}
            />
            <div className="sch-toggle-row">
              <span>
                <strong>Notify on</strong>
                <small>Which finished runs send an alert to your devices</small>
              </span>
              <Select
                aria-label="Notify on"
                value={form.notify}
                onChange={(e) => set({ notify: e.target.value as ScheduleForm['notify'] })}
              >
                <option value="always">Every run</option>
                <option value="failure">Failure only</option>
                <option value="never">Never</option>
              </Select>
            </div>
          </section>
        </div>

        <aside className="sch-editor-side">
          <section className="sch-card sch-summary">
            <span className="sch-eyebrow">Summary</span>
            <strong className="sch-summary-line">
              {'error' in trigger ? 'Pick when it runs' : summaryLine(trigger)}
            </strong>
            <span className="sch-eyebrow">Next runs</span>
            {preview?.error ? (
              <p className="sch-hint error">{preview.error}</p>
            ) : preview?.times.length ? (
              <ol className="sch-next">
                {preview.times.map((t, i) => {
                  const { day, time } = dayAndTime(
                    t,
                    'error' in trigger || trigger.kind !== 'cron' ? undefined : trigger.timezone,
                  )
                  return (
                    <li key={t} className={i === 0 ? 'first' : ''}>
                      <span className="dot" />
                      <span>{day}</span>
                      <span className="sch-muted">{time}</span>
                    </li>
                  )
                })}
              </ol>
            ) : (
              <p className="sch-muted">Never fires</p>
            )}
            {!form.id && (
              <div className="sch-summary-switch">
                <ToggleRow
                  title="Enable after saving"
                  hint="Start on the next scheduled time"
                  checked={form.enabled}
                  onChange={(enabled) => set({ enabled })}
                />
              </div>
            )}
          </section>
          <p className="sch-info">
            <Info size={14} />
            <span>
              Tasks run on the host in its own time zone, even with every app closed. Missed runs
              are not made up after the host was off.
            </span>
          </p>
        </aside>
      </div>

      {(problem ?? error) && (
        <p className="settings-error" role="alert">
          {problem ?? error}
        </p>
      )}
      <footer className="sch-foot">
        {onRemove ? (
          confirmDelete ? (
            <span className="sch-confirm">
              Delete this task? Sessions it started stay.
              <Button
                variant="app"
                type="button"
                className="settings-button danger"
                disabled={busy}
                onClick={onRemove}
              >
                Delete
              </Button>
              <Button
                variant="app"
                type="button"
                className="settings-button"
                onClick={() => setConfirmDelete(false)}
              >
                Keep
              </Button>
            </span>
          ) : (
            <Button
              variant="app"
              type="button"
              className="settings-button danger"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={13} /> Delete task
            </Button>
          )
        ) : (
          <span />
        )}
        <span className="sch-foot-actions">
          <Button
            variant="app"
            type="button"
            className="settings-button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button variant="app" className="settings-button primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save task'}
          </Button>
        </span>
      </footer>
    </form>
  )
}
