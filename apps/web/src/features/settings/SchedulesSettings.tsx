import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CalendarClock, Pause, Pencil, Play, Plus, Trash2, Zap } from 'lucide-react'
import type { Schedule, ScheduleRun } from '@beddcode/contracts'
import { hostRequest, readyProviders, useAllSessions, useRuntime } from '../../stores/host.ts'
import { folderName, timeAgo } from '../../ui/format.ts'
import { Select } from '../../ui/Select.tsx'
import {
  describeTrigger,
  emptyScheduleForm,
  formToInput,
  formTrigger,
  runLabel,
  scheduleToForm,
  type ScheduleForm,
} from './scheduleForm.ts'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
const when = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  })

/** Prompts one host runs on a timer, whether or not any app is open. */
export function SchedulesSettings({ hostKey }: { hostKey: string }) {
  const { connection, epoch } = useRuntime(hostKey)
  const online = connection === 'connected'
  const [data, setData] = useState<{ schedules: Schedule[]; runs: ScheduleRun[] }>()
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<ScheduleForm>()
  const [busy, setBusy] = useState(false)

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

  return (
    <>
      <div className="settings-section-head">
        <h3>Schedules</h3>
        <div className="settings-actions">
          <button
            className="settings-button primary"
            disabled={!online || busy || editing !== undefined}
            onClick={() => setEditing(emptyScheduleForm())}
          >
            <Plus size={14} /> New schedule
          </button>
        </div>
      </div>
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
      {editing && (
        <ScheduleEditor
          hostKey={hostKey}
          form={editing}
          busy={busy}
          onChange={setEditing}
          onCancel={() => setEditing(undefined)}
          onSave={(input) =>
            run(async () => {
              await hostRequest(hostKey, 'schedules.save', input)
              setEditing(undefined)
            })
          }
        />
      )}
      <div className="settings-card">
        {data?.schedules.length === 0 && !editing && (
          <p className="settings-empty">
            No schedules yet. A schedule sends a prompt on a timer: a fresh session each time, or a
            heartbeat to one you already have.
          </p>
        )}
        {data?.schedules.map((s) => (
          <ScheduleRow
            key={s.id}
            schedule={s}
            runs={data.runs.filter((r) => r.scheduleId === s.id)}
            disabled={!online || busy}
            onEdit={() => setEditing(scheduleToForm(s))}
            onPause={() =>
              run(() =>
                hostRequest(hostKey, 'schedules.setPaused', { id: s.id, paused: !s.paused }),
              )
            }
            onRunNow={() => run(() => hostRequest(hostKey, 'schedules.runNow', { id: s.id }))}
            onRemove={() => run(() => hostRequest(hostKey, 'schedules.remove', { id: s.id }))}
          />
        ))}
      </div>
      <p className="settings-footnote">
        Schedules run on the host in its own time zone, even with every app closed. A run is skipped
        while the previous one is still going, and missed runs are not made up after the host was
        off. Turn on “A scheduled run finishes” in phone alerts to hear about each run.
      </p>
    </>
  )
}

function ScheduleRow({
  schedule: s,
  runs,
  disabled,
  onEdit,
  onPause,
  onRunNow,
  onRemove,
}: {
  schedule: Schedule
  runs: ScheduleRun[]
  disabled: boolean
  onEdit(): void
  onPause(): void
  onRunNow(): void
  onRemove(): void
}) {
  const [confirm, setConfirm] = useState(false)
  return (
    <div className="schedule-row">
      <div className="setting-row">
        <CalendarClock size={18} />
        <div className="setting-label">
          <span>
            {s.name}
            {s.paused && <span className="settings-badge">Paused</span>}
          </span>
          <small>
            {describeTrigger(s.trigger)} ·{' '}
            {s.target.kind === 'session'
              ? 'Heartbeat to a session'
              : `New ${s.target.instanceId} session`}
            {s.target.kind === 'new' && s.target.cwd ? ` in ${folderName(s.target.cwd)}` : ''}
            {s.target.kind === 'new' && s.target.worktree ? ' (worktree)' : ''}
            {s.nextRunAt && !s.paused ? ` · next ${when(s.nextRunAt)}` : ''}
          </small>
        </div>
        <button
          className="icon-btn"
          aria-label={`Run ${s.name} now`}
          title="Run now"
          disabled={disabled}
          onClick={onRunNow}
        >
          <Zap size={15} />
        </button>
        <button
          className="icon-btn"
          aria-label={s.paused ? `Resume ${s.name}` : `Pause ${s.name}`}
          title={s.paused ? 'Resume' : 'Pause'}
          disabled={disabled}
          onClick={onPause}
        >
          {s.paused ? <Play size={15} /> : <Pause size={15} />}
        </button>
        <button
          className="icon-btn"
          aria-label={`Edit ${s.name}`}
          title="Edit"
          disabled={disabled}
          onClick={onEdit}
        >
          <Pencil size={15} />
        </button>
        <button
          className="icon-btn"
          aria-label={`Delete ${s.name}`}
          title="Delete"
          disabled={disabled}
          onClick={() => setConfirm(true)}
        >
          <Trash2 size={15} />
        </button>
      </div>
      {confirm && (
        <div className="settings-notice" role="alert">
          <p>Delete {s.name}? Sessions it started stay.</p>
          <div className="settings-actions">
            <button className="settings-button" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button className="settings-button danger" onClick={onRemove}>
              Delete
            </button>
          </div>
        </div>
      )}
      <p className="schedule-prompt" title={s.prompt}>
        {s.prompt}
      </p>
      {runs.length > 0 && (
        <ol className="schedule-runs" aria-label={`Recent runs of ${s.name}`}>
          {runs.slice(0, 5).map((r) => (
            <li key={r.id} className={`run-${r.status}`}>
              <span
                className={`dot ${r.status === 'running' ? 'running' : r.status === 'done' ? 'ok' : r.status === 'skipped' ? '' : 'warn'}`}
              />
              <span>{runLabel(r)}</span>
              <span className="muted">
                {timeAgo(r.startedAt)} ago{r.manual ? ' · by hand' : ''}
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
    </div>
  )
}

function ScheduleEditor({
  hostKey,
  form,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  hostKey: string
  form: ScheduleForm
  busy: boolean
  onChange(form: ScheduleForm): void
  onCancel(): void
  onSave(input: Parameters<typeof hostRequest<'schedules.save'>>[2]): void
}) {
  const { providers, projects } = useRuntime(hostKey)
  const agents = readyProviders(providers)
  const sessions = useAllSessions().filter((h) => h.hostKey === hostKey)
  const [problem, setProblem] = useState<string>()
  const [preview, setPreview] = useState<{ times: number[]; error?: string }>()
  const set = (patch: Partial<ScheduleForm>) => onChange({ ...form, ...patch })
  const agent = agents.find((a) => a.id === form.instanceId)

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
      void hostRequest(hostKey, 'schedules.preview', { trigger: parsed, count: 3 }).then(
        (p) => live && setPreview(p),
        (err: unknown) => live && setPreview({ times: [], error: errorMessage(err) }),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [hostKey, triggerKey])

  return (
    <form
      className="settings-card mcp-form schedule-form"
      onSubmit={(e) => {
        e.preventDefault()
        const result = formToInput(form)
        if ('error' in result) return setProblem(result.error)
        setProblem(undefined)
        onSave(result.input)
      }}
    >
      <label>
        Name
        <input
          autoFocus
          value={form.name}
          placeholder="Morning triage"
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>
      <label>
        Prompt
        <textarea
          rows={3}
          value={form.prompt}
          placeholder="Check the open issues and summarise anything new."
          onChange={(e) => set({ prompt: e.target.value })}
        />
      </label>
      <div className="schedule-form-row">
        <label>
          Runs
          <Select
            value={form.triggerKind}
            onChange={(e) => set({ triggerKind: e.target.value as ScheduleForm['triggerKind'] })}
          >
            <option value="every">Every N minutes</option>
            <option value="cron">On a cron schedule</option>
          </Select>
        </label>
        {form.triggerKind === 'every' ? (
          <label>
            Minutes
            <input
              inputMode="numeric"
              value={form.minutes}
              onChange={(e) => set({ minutes: e.target.value })}
            />
          </label>
        ) : (
          <label>
            Cron expression
            <input
              className="mono"
              value={form.expr}
              placeholder="0 9 * * 1-5"
              onChange={(e) => set({ expr: e.target.value })}
            />
          </label>
        )}
      </div>
      <small
        className={preview?.error ? 'schedule-preview error' : 'schedule-preview'}
        role="status"
      >
        {preview?.error ??
          (preview?.times.length ? `Next: ${preview.times.map(when).join(' · ')}` : 'Never fires')}
      </small>
      <label>
        Each run
        <Select
          value={form.targetKind}
          onChange={(e) => set({ targetKind: e.target.value as ScheduleForm['targetKind'] })}
        >
          <option value="new">Starts a fresh session</option>
          <option value="session">Sends a heartbeat to an existing session</option>
        </Select>
      </label>
      {form.targetKind === 'session' ? (
        <label>
          Session
          <Select value={form.sessionId} onChange={(e) => set({ sessionId: e.target.value })}>
            <option value="">Choose a session…</option>
            {sessions.map(({ session }) => (
              <option key={session.id} value={session.id}>
                {session.title || 'Untitled'}
              </option>
            ))}
          </Select>
        </label>
      ) : (
        <>
          <div className="schedule-form-row">
            <label>
              Agent
              <Select
                value={form.instanceId}
                onChange={(e) => set({ instanceId: e.target.value, model: '', permissionMode: '' })}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </label>
            {(agent?.capabilities.models?.length ?? 0) > 0 && (
              <label>
                Model
                <Select value={form.model} onChange={(e) => set({ model: e.target.value })}>
                  <option value="">Agent default</option>
                  {agent!.capabilities.models!.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {(agent?.capabilities.permissionModes.length ?? 0) > 0 && (
              <label>
                Permissions
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
              </label>
            )}
          </div>
          <div className="schedule-form-row">
            <label>
              Folder
              <Select value={form.cwd} onChange={(e) => set({ cwd: e.target.value })}>
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
            {projects.some((p) => p.path === form.cwd && p.isRepo) && (
              <label className="schedule-check">
                <input
                  type="checkbox"
                  checked={form.worktree}
                  onChange={(e) => set({ worktree: e.target.checked })}
                />
                A new worktree for each run
              </label>
            )}
          </div>
        </>
      )}
      {problem && (
        <p className="settings-error" role="alert">
          {problem}
        </p>
      )}
      <div className="settings-actions">
        <button type="button" className="settings-button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="settings-button primary" disabled={busy}>
          {busy ? 'Saving…' : form.id ? 'Save changes' : 'Create schedule'}
        </button>
      </div>
    </form>
  )
}
