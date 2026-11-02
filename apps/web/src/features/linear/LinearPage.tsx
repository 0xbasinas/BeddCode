import { Select } from '../../ui/Select.tsx'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  LinearClient,
  PaginationOrderBy,
  type Issue,
  type Team,
  type WorkflowState,
} from '@linear/sdk'
import {
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Lightbulb,
  KeyRound,
  LoaderCircle,
  LogOut,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { setHandoff } from '../../stores/handoff.ts'
import { hostRequest } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { Markdown } from '../../ui/Markdown.tsx'
import { LinearConnection } from './LinearConnection.tsx'
import { DisplayMenu, FilterMenu } from './LinearMenus.tsx'
import {
  applyFilters,
  groupRows,
  isOverdue,
  NO_FILTERS,
  readDefaults,
  readDisplay,
  writeDisplay,
  type Defaults,
  type Display,
  type Filters,
} from './linearPrefs.ts'
import '../settings/settings.css'
import './linear.css'

const KEY_STORAGE = 'beddcode.linear-api-key'

type Tab = 'team' | 'ideas' | 'mine' | 'cycle'

/** Labels that mark an issue as an idea (triage issues count too). */
const IDEA_LABELS = ['Idea', 'Ideas', 'idea', 'ideas']

interface IssueRow {
  issue: Issue
  id: string
  identifier: string
  title: string
  url: string
  priority: number
  priorityLabel: string
  state: string
  stateId?: string
  stateType: string
  stateColor: string
  teamId?: string
  assignee: string
  project: string
  cycle: string
  labels: string[]
  dueDate?: string
  estimate?: number
  updatedAt: Date
}

interface Comment {
  id: string
  author: string
  body: string
  createdAt: Date
}

interface SubIssue {
  id: string
  identifier: string
  title: string
  done: boolean
}

interface Detail {
  description: string
  children: SubIssue[]
  branchName: string
  comments: Comment[]
  states: WorkflowState[]
}

interface Loaded {
  viewerId: string
  name: string
  email: string
  org: string
  urlKey: string
  teams: Team[]
}

interface Account {
  id: string
  key: string
  label: string
}

interface Store {
  accounts: Account[]
  active: string
}

const ACCOUNTS_STORAGE = 'beddcode.linear-accounts'

function readStore(): Store {
  try {
    const saved = JSON.parse(localStorage.getItem(ACCOUNTS_STORAGE) ?? 'null') as Store | null
    if (saved && Array.isArray(saved.accounts)) return saved
    // The single key kept before accounts could be added.
    const legacy = localStorage.getItem(KEY_STORAGE)
    if (legacy) return { accounts: [{ id: 'a1', key: legacy, label: 'Linear' }], active: 'a1' }
  } catch {
    // Start empty.
  }
  return { accounts: [], active: '' }
}

function writeStore(store: Store) {
  try {
    localStorage.setItem(ACCOUNTS_STORAGE, JSON.stringify(store))
    localStorage.removeItem(KEY_STORAGE)
  } catch {
    // Still works for this window.
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Resolves an issue's relations into plain fields, so rows render without more requests. */
async function toRow(issue: Issue): Promise<IssueRow> {
  const [state, team, assignee, project, cycle, labels] = await Promise.all([
    issue.state,
    issue.team,
    issue.assignee,
    issue.project,
    issue.cycle,
    issue.labels(),
  ])
  return {
    issue,
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    state: state?.name ?? '',
    stateId: state?.id,
    stateType: state?.type ?? 'unstarted',
    stateColor: state?.color ?? '',
    teamId: team?.id,
    assignee: assignee?.displayName ?? '',
    project: project?.name ?? '',
    cycle: cycle ? (cycle.name ?? `Cycle ${cycle.number}`) : '',
    labels: labels.nodes.map((l) => l.name),
    dueDate: issue.dueDate ?? undefined,
    estimate: issue.estimate ?? undefined,
    updatedAt: issue.updatedAt,
  }
}

const OPEN = { type: { nin: ['completed', 'canceled'] } }

/** Linear on its own screen: your issues, a team's, and its current cycle, via personal API keys. */
export function LinearPage() {
  const [store, setStore] = useState(readStore)
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<'main' | 'connect'>('main')
  const [data, setData] = useState<Loaded>()
  const [error, setError] = useState<string>()
  const account = store.accounts.find((a) => a.id === store.active) ?? store.accounts[0]
  const apiKey = account?.key
  const client = useMemo(() => (apiKey ? new LinearClient({ apiKey }) : undefined), [apiKey])
  // Agents with Linear tools run on the host, so it keeps a copy of the active key.
  useEffect(() => {
    try {
      hostRequest(LOCAL_HOST_KEY, 'linear.setKey', { key: apiKey ?? null }).catch(() => {})
    } catch {
      // No connection to the host yet; the next change sends it.
    }
  }, [apiKey])
  const update = (next: Store) => {
    writeStore(next)
    setStore(next)
  }

  useEffect(() => {
    if (!client) return
    let current = true
    setError(undefined)
    setData(undefined)
    Promise.all([client.viewer, client.organization, client.teams()]).then(
      ([me, org, teams]) => {
        if (!current) return
        setData({
          viewerId: me.id,
          name: me.displayName,
          email: me.email,
          org: org.name,
          urlKey: org.urlKey,
          teams: teams.nodes,
        })
        // Accounts are named after their workspace once Linear says which it is.
        const label = `${org.name} · ${me.displayName}`
        setStore((s) => {
          if (s.accounts.find((a) => a.key === apiKey)?.label === label) return s
          const next = {
            ...s,
            accounts: s.accounts.map((a) => (a.key === apiKey ? { ...a, label } : a)),
          }
          writeStore(next)
          return next
        })
      },
      (err: unknown) => {
        if (!current) return
        setData(undefined)
        setError(message(err))
      },
    )
    return () => {
      current = false
    }
  }, [client, apiKey])

  const submitKey = () => {
    const key = draft.trim()
    if (!key) return
    const existing = store.accounts.find((a) => a.key === key)
    const id = existing?.id ?? `a${Date.now().toString(36)}`
    update({
      accounts: existing ? store.accounts : [...store.accounts, { id, key, label: 'Linear' }],
      active: id,
    })
    setDraft('')
  }
  const removeAccount = () => {
    if (!account) return
    const accounts = store.accounts.filter((a) => a.id !== account.id)
    update({ accounts, active: accounts[0]?.id ?? '' })
    setData(undefined)
    setError(undefined)
    setView('main')
  }

  const keyForm = (
    <form
      className="lin-key-form"
      onSubmit={(e) => {
        e.preventDefault()
        submitKey()
      }}
    >
      <KeyRound size={15} />
      <Input
        className="settings-input"
        type="password"
        autoComplete="off"
        aria-label="Linear API key"
        placeholder="lin_api_…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        style={{ flex: 1 }}
      />
      <Button
        variant="app"
        className="settings-button primary"
        type="submit"
        disabled={!draft.trim()}
      >
        Connect
      </Button>
    </form>
  )

  return (
    <main className="panel settings-main linear-page">
      <div className="settings-content linear-content">
        <header className="lin-head" hidden={view === 'connect' && Boolean(client)}>
          <div>
            <h2>Linear</h2>
            <p>Issues and ideas from your workspace, synced both ways with your agents.</p>
          </div>
          {client && (
            <div className="lin-head-actions">
              <span className={`lin-status ${data ? 'ok' : error ? 'bad' : ''}`}>
                <i />
                {data ? `Connected · ${data.name}` : error ? 'Not connected' : 'Connecting…'}
              </span>
              <Button
                variant="app"
                className="settings-button"
                aria-pressed={view === 'connect'}
                onClick={() => setView((v) => (v === 'connect' ? 'main' : 'connect'))}
              >
                Connection
              </Button>
              {data && (
                <a
                  className="settings-button"
                  href={`https://linear.app/${data.urlKey}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={13} /> Open in Linear
                </a>
              )}
            </div>
          )}
        </header>
        {!client ? (
          <section className="lin-connect">
            <div className="lin-connect-icon">
              <KeyRound size={18} />
            </div>
            <h3>Connect Linear</h3>
            <p>
              Paste a personal API key from Linear → Settings → Security. It stays on this device,
              and agents on this host use it to read, file and update issues.
            </p>
            {keyForm}
          </section>
        ) : (
          <>
            {error && <ErrorCard title="Could not load Linear" text={error} />}
            {data && view === 'connect' && (
              <LinearConnection
                client={client}
                org={data.org}
                name={data.name}
                email={data.email}
                apiKey={apiKey ?? ''}
                teams={data.teams}
                accounts={store.accounts.map((a) => ({ id: a.id, label: a.label }))}
                activeId={account?.id ?? ''}
                keyForm={keyForm}
                onSelectAccount={(id) => update({ ...store, active: id })}
                onRemove={removeAccount}
                onClose={() => setView('main')}
              />
            )}
            {data && view === 'main' && (
              <Workspace
                key={apiKey}
                client={client}
                teams={data.teams}
                me={{ id: data.viewerId, name: data.name }}
              />
            )}
          </>
        )}
      </div>
    </main>
  )
}

function ErrorCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="lin-card lin-error" role="alert">
      <CircleAlert size={16} />
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
    </div>
  )
}

interface CycleInfo {
  name: string
  starts: Date
  ends: Date
  progress: number
  done: number
  started: number
  todo: number
}

const shortDate = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const dayLabel = (iso: string | Date) => shortDate(typeof iso === 'string' ? new Date(iso) : iso)

function Workspace({
  client,
  teams,
  me,
}: {
  client: LinearClient
  teams: Team[]
  me: { id: string; name: string }
}) {
  const [tab, setTab] = useState<Tab>('team')
  const [defaults] = useState<Defaults>(readDefaults)
  const [teamId, setTeamId] = useState(
    teams.find((t) => t.id === defaults.teamId)?.id ?? teams[0]?.id ?? '',
  )
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [display, setDisplay] = useState<Display>(readDisplay)
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<IssueRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [note, setNote] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [cycle, setCycle] = useState<CycleInfo | null>()
  const [capture, setCapture] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    setNote(undefined)
    try {
      let issues: Issue[]
      if (tab === 'mine') {
        const me = await client.viewer
        issues = (
          await me.assignedIssues({
            first: 50,
            orderBy: PaginationOrderBy.UpdatedAt,
            filter: { state: OPEN },
          })
        ).nodes
      } else if (tab === 'ideas') {
        issues = (
          await client.issues({
            first: 50,
            orderBy: PaginationOrderBy.UpdatedAt,
            filter: {
              team: { id: { eq: teamId } },
              state: OPEN,
              or: [
                { labels: { some: { name: { in: IDEA_LABELS } } } },
                { state: { type: { eq: 'triage' } } },
              ],
            },
          })
        ).nodes
      } else if (tab === 'team') {
        const text = query.trim()
        issues = (
          await client.issues({
            first: 50,
            orderBy: PaginationOrderBy.UpdatedAt,
            filter: {
              team: { id: { eq: teamId } },
              state: OPEN,
              ...(text ? { title: { containsIgnoreCase: text } } : {}),
            },
          })
        ).nodes
      } else {
        const team = await client.team(teamId)
        const active = await team.activeCycle
        if (active) {
          issues = (await active.issues({ first: 100 })).nodes
        } else {
          setNote('This team has no active cycle.')
          issues = []
        }
      }
      setRows(await Promise.all(issues.map(toRow)))
    } catch (err) {
      setRows([])
      setError(message(err))
    } finally {
      setLoading(false)
    }
  }, [client, tab, teamId, query])

  // Typing in the search waits for a pause before asking Linear.
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), tab === 'team' && query ? 350 : 0)
    return () => clearTimeout(timer)
  }, [refresh, tab, query])

  // The cycle card follows the chosen team.
  useEffect(() => {
    let current = true
    setCycle(undefined)
    void (async () => {
      try {
        const team = await client.team(teamId)
        const active = await team.activeCycle
        if (!active) return current && setCycle(null)
        const issues = (await active.issues({ first: 100 })).nodes
        const states = await Promise.all(issues.map((i) => i.state))
        if (!current) return
        const count = (f: (type: string) => boolean) =>
          states.filter((s) => f(s?.type ?? 'unstarted')).length
        setCycle({
          name: active.name ?? `Cycle ${active.number}`,
          starts: active.startsAt,
          ends: active.endsAt,
          progress: active.progress,
          done: count((t) => t === 'completed'),
          started: count((t) => t === 'started'),
          todo: count((t) => t !== 'completed' && t !== 'started' && t !== 'canceled'),
        })
      } catch {
        if (current) setCycle(null)
      }
    })()
    return () => {
      current = false
    }
  }, [client, teamId])

  const searched = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text || tab === 'team') return rows
    return rows.filter((r) => `${r.identifier} ${r.title}`.toLowerCase().includes(text))
  }, [rows, query, tab])
  const visible = useMemo(
    () => applyFilters(searched, filters, me.name),
    [searched, filters, me.name],
  )
  const groups = useMemo(
    () => groupRows(visible, display.groupBy, display.sortBy),
    [visible, display.groupBy, display.sortBy],
  )
  const labelChoices = useMemo(() => [...new Set(rows.flatMap((r) => r.labels))].sort(), [rows])
  const projectChoices = useMemo(
    () => [...new Set(rows.map((r) => r.project).filter(Boolean))].sort(),
    [rows],
  )
  const overdue = visible.filter(isOverdue).length
  const selected = visible.find((r) => r.id === selectedId) ?? visible[0]
  const changeDisplay = (next: Display) => {
    setDisplay(next)
    writeDisplay(next)
  }

  const submitCapture = async () => {
    const title = capture.trim()
    if (!title || capturing) return
    setCapturing(true)
    setCaptureError(undefined)
    try {
      const result = await client.createIssue({
        teamId,
        title,
        projectId: defaults.projectId || undefined,
        assigneeId: defaults.assignee === 'me' ? me.id : undefined,
      })
      if (!result.success) throw new Error('Linear did not create the issue.')
      setCapture('')
      void refresh()
    } catch (err) {
      setCaptureError(message(err))
    } finally {
      setCapturing(false)
    }
  }

  const total = cycle ? cycle.done + cycle.started + cycle.todo : 0
  return (
    <div className="linear-workspace">
      <div className="lin-top">
        <section className="lin-card lin-cycle">
          <div className="lin-card-head">
            <strong>{cycle ? cycle.name : 'Cycle'}</strong>
            {cycle && (
              <span>
                {shortDate(cycle.starts)} – {shortDate(cycle.ends)}
              </span>
            )}
          </div>
          {cycle ? (
            <>
              <div
                className="lin-meter"
                role="img"
                aria-label={`${Math.round(cycle.progress * 100)}% done`}
              >
                <span className="done" style={{ flex: cycle.done || 0 }} />
                <span className="started" style={{ flex: cycle.started || 0 }} />
                <span className="todo" style={{ flex: Math.max(cycle.todo, total ? 0 : 1) }} />
              </div>
              <div className="lin-legend">
                <span>
                  <i className="done" />
                  {cycle.done} done
                </span>
                <span>
                  <i className="started" />
                  {cycle.started} in progress
                </span>
                <span>
                  <i className="todo" />
                  {cycle.todo} to do
                </span>
              </div>
            </>
          ) : (
            <p className="lin-muted">
              {cycle === null ? 'This team has no active cycle.' : 'Loading…'}
            </p>
          )}
        </section>
        <section className="lin-card lin-capture">
          <div className="lin-card-head">
            <strong>
              <Sparkles size={13} /> Quick capture
            </strong>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void submitCapture()
            }}
          >
            <Input
              aria-label="Quick capture"
              placeholder="Jot down an idea or bug, press Enter to file it in Linear…"
              value={capture}
              disabled={capturing}
              onChange={(e) => setCapture(e.target.value)}
            />
            <kbd>↵</kbd>
          </form>
          {captureError && <small className="lin-bad">{captureError}</small>}
        </section>
      </div>

      <div className="lin-toolbar">
        <div className="lin-tabs" role="tablist" aria-label="Linear views">
          {(
            [
              ['team', 'Issues'],
              ['ideas', 'Ideas'],
              ['mine', 'Assigned to me'],
              ['cycle', 'Cycle'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
              {tab === id && visible.length > 0 && <span>{visible.length}</span>}
            </button>
          ))}
        </div>
        <span className="lin-spacer" />
        <label className="lin-search">
          <Search size={13} />
          <input
            aria-label="Search issue titles"
            placeholder="Search issues"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <FilterMenu
          filters={filters}
          labels={labelChoices}
          projects={projectChoices}
          onChange={setFilters}
        />
        <DisplayMenu display={display} onChange={changeDisplay} />
        {tab !== 'mine' && (
          <Select
            className="settings-input"
            aria-label="Team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
        <Button
          variant="app"
          className="settings-button"
          aria-label="Refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
        </Button>
        <Button variant="app" className="settings-button primary" onClick={() => setCreating(true)}>
          <Plus size={14} /> New issue
        </Button>
      </div>
      {creating && (
        <NewIssue
          client={client}
          teams={teams}
          defaultTeam={teamId}
          defaults={defaults}
          me={me}
          onCancel={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            void refresh()
          }}
        />
      )}
      {error && <ErrorCard title="Could not load issues" text={error} />}
      {note && !error && <p className="lin-muted lin-note">{note}</p>}

      <div className="lin-split">
        <div className="lin-scroll">
          {!loading && !error && visible.length === 0 && !note && (
            <div className="lin-empty">
              <span className="linear-empty-icon">
                <CircleCheck size={19} />
              </span>
              <strong>{tab === 'mine' ? 'You’re all caught up' : 'No open issues found'}</strong>
              <span className="lin-muted">
                {tab === 'mine'
                  ? 'Issues assigned to you will show up here.'
                  : 'Try another view or create an issue for your team.'}
              </span>
              <Button
                variant="app"
                className="settings-button primary"
                onClick={() => setCreating(true)}
              >
                <Plus size={14} /> Create an issue
              </Button>
            </div>
          )}
          {visible.length > 0 && (
            <div className="lin-list">
              {groups.map((group) => (
                <section key={group.key}>
                  <h3 className="lin-group">
                    {group.state && <StateIcon type={group.state.type} color={group.state.color} />}
                    {group.label} <span>{group.rows.length}</span>
                  </h3>
                  {group.rows.map((row) => (
                    <button
                      key={row.id}
                      className={`lin-row ${selected?.id === row.id ? 'selected' : ''}`}
                      aria-pressed={selected?.id === row.id}
                      onClick={() => setSelectedId(row.id)}
                    >
                      {tab === 'ideas' ? (
                        <Lightbulb size={14} className="lin-prio idea" />
                      ) : (
                        <PriorityIcon priority={row.issue.priority} />
                      )}
                      <span className="linear-id">{row.identifier}</span>
                      <StateIcon type={row.stateType} color={row.stateColor} />
                      <span className="lin-title">{row.title}</span>
                      {display.showLabels &&
                        row.labels.slice(0, 2).map((l) => (
                          <span key={l} className="linear-chip label">
                            {l}
                          </span>
                        ))}
                      {row.assignee && (
                        <span className="lin-assignee" title={row.assignee}>
                          {row.assignee.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className={`lin-date ${isOverdue(row) ? 'overdue' : ''}`}>
                        {row.dueDate ? dayLabel(row.dueDate) : dayLabel(row.updatedAt)}
                      </span>
                    </button>
                  ))}
                </section>
              ))}
              {overdue > 0 && <p className="lin-muted lin-note">{overdue} overdue</p>}
            </div>
          )}
        </div>
        {selected && (
          <IssueDetail
            key={selected.id}
            client={client}
            row={selected}
            onChanged={() => void refresh()}
          />
        )}
      </div>
    </div>
  )
}

function StateIcon({ type, color }: { type: string; color: string }) {
  return (
    <span
      className={`lin-state ${type}`}
      style={color ? ({ '--c': color } as CSSProperties) : undefined}
      aria-hidden="true"
    />
  )
}

/** Four bars in Linear's own order: urgent, high, medium, low; none shows a dash. */
function PriorityIcon({ priority }: { priority: number }) {
  if (priority === 1) return <CircleAlert size={14} className="lin-prio urgent" />
  const level = priority === 2 ? 3 : priority === 3 ? 2 : priority === 4 ? 1 : 0
  if (level === 0) return <span className="lin-prio none">···</span>
  return (
    <span className="lin-prio" aria-label={`Priority ${level}`}>
      {[1, 2, 3].map((n) => (
        <i key={n} className={n <= level ? 'on' : ''} />
      ))}
    </span>
  )
}

function NewIssue({
  client,
  teams,
  defaultTeam,
  defaults,
  me,
  onCancel,
  onDone,
}: {
  client: LinearClient
  teams: Team[]
  defaultTeam: string
  defaults: Defaults
  me: { id: string; name: string }
  onCancel(): void
  onDone(): void
}) {
  const [teamId, setTeamId] = useState(defaultTeam)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const teamKey = teams.find((t) => t.id === teamId)?.key
  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await client.createIssue({
        teamId,
        title: title.trim(),
        description: description.trim() || undefined,
        projectId: defaults.projectId || undefined,
        assigneeId: defaults.assignee === 'me' ? me.id : undefined,
      })
      if (!result.success) throw new Error('Linear did not create the issue.')
      onDone()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="lin-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <form
        className="lin-modal"
        role="dialog"
        aria-label="New issue"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) {
            e.preventDefault()
            onCancel()
          }
        }}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="lin-modal-head">
          <span className="lin-crumb">
            {teamKey ?? 'Team'} <i>›</i> New issue
          </span>
          <button type="button" aria-label="Close" onClick={onCancel} disabled={busy}>
            <X size={15} />
          </button>
        </div>
        <Input
          autoFocus
          className="lin-modal-title"
          aria-label="Issue title"
          placeholder="Issue title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Textarea
          className="lin-modal-body"
          aria-label="Issue description"
          placeholder="Add description… (markdown)"
          rows={5}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="lin-modal-props">
          <Select
            className="settings-input"
            aria-label="Team for the new issue"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        {error && <small className="lin-bad">{error}</small>}
        <div className="lin-modal-foot">
          <Button
            variant="app"
            className="settings-button"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="app"
            className="settings-button primary"
            type="submit"
            disabled={busy || !title.trim()}
          >
            Create issue
          </Button>
        </div>
      </form>
    </div>
  )
}

function IssueDetail({
  client,
  row,
  onChanged,
}: {
  client: LinearClient
  row: IssueRow
  onChanged(): void
}) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<Detail>()
  const [error, setError] = useState<string>()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)

  const loadDetail = useCallback(async () => {
    try {
      const [team, comments, children] = await Promise.all([
        row.issue.team,
        row.issue.comments(),
        row.issue.children(),
      ])
      const [states, authors, childStates] = await Promise.all([
        team ? team.states() : undefined,
        Promise.all(comments.nodes.map((c) => c.user)),
        Promise.all(children.nodes.map((c) => c.state)),
      ])
      setDetail({
        description: row.issue.description ?? '',
        branchName: row.issue.branchName,
        states: states?.nodes ?? [],
        children: children.nodes.map((c, i) => ({
          id: c.id,
          identifier: c.identifier,
          title: c.title,
          done: childStates[i]?.type === 'completed',
        })),
        comments: comments.nodes.map((c, i) => ({
          id: c.id,
          author: authors[i]?.displayName ?? 'Someone',
          body: c.body,
          createdAt: c.createdAt,
        })),
      })
    } catch (err) {
      setError(message(err))
    }
  }, [row.issue])

  useEffect(() => {
    if (!detail) void loadDetail()
  }, [detail, loadDetail])

  const act = async (work: () => Promise<{ success: boolean }>, after: () => void) => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await work()
      if (!result.success) throw new Error('Linear did not accept the change.')
      after()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  const startSession = () => {
    const prompt = [
      `Work on Linear issue ${row.identifier}: ${row.title}`,
      row.url,
      detail?.branchName ? `Suggested branch: ${detail.branchName}` : '',
      detail?.description ? `\n${detail.description}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    setHandoff(LOCAL_HOST_KEY, prompt)
    void navigate({ to: '/', search: { host: LOCAL_HOST_KEY, compose: true } })
  }

  const subDone = detail?.children.filter((c) => c.done).length ?? 0
  return (
    <aside className="lin-detail" aria-label={`${row.identifier} details`}>
      <div className="lin-detail-head">
        <span className="linear-id">{row.identifier}</span>
        <MoreHorizontal size={15} aria-hidden="true" />
      </div>
      <h3>{row.title}</h3>
      {!detail && !error && <p className="lin-muted">Loading…</p>}
      {detail &&
        (detail.description ? (
          <div className="linear-markdown lin-desc">
            <Markdown text={detail.description} />
          </div>
        ) : (
          <p className="lin-muted">No description.</p>
        ))}
      <dl className="lin-props">
        <div>
          <dt>Status</dt>
          <dd>
            {detail ? (
              <Select
                className="settings-input"
                aria-label="Status"
                value={row.stateId}
                disabled={busy}
                onChange={(e) =>
                  void act(() => client.updateIssue(row.id, { stateId: e.target.value }), onChanged)
                }
              >
                {detail.states
                  .slice()
                  .sort((a, b) => a.position - b.position)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            ) : (
              row.state
            )}
          </dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{row.priorityLabel}</dd>
        </div>
        <div>
          <dt>Assignee</dt>
          <dd>{row.assignee || 'Unassigned'}</dd>
        </div>
        {row.project && (
          <div>
            <dt>Project</dt>
            <dd>{row.project}</dd>
          </div>
        )}
        {row.cycle && (
          <div>
            <dt>Cycle</dt>
            <dd>{row.cycle}</dd>
          </div>
        )}
        {row.estimate != null && (
          <div>
            <dt>Estimate</dt>
            <dd>{row.estimate} pts</dd>
          </div>
        )}
        {row.dueDate && (
          <div>
            <dt>Due</dt>
            <dd className={isOverdue(row) ? 'lin-bad' : ''}>{dayLabel(row.dueDate)}</dd>
          </div>
        )}
        {row.labels.length > 0 && (
          <div>
            <dt>Labels</dt>
            <dd className="lin-labels">
              {row.labels.map((l) => (
                <span key={l} className="linear-chip label">
                  {l}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
      {detail && detail.children.length > 0 && (
        <>
          <h4 className="lin-eyebrow">
            Sub-issues · {subDone} / {detail.children.length}
          </h4>
          <ul className="lin-subs">
            {detail.children.map((c) => (
              <li key={c.id} className={c.done ? 'done' : ''}>
                <StateIcon type={c.done ? 'completed' : 'unstarted'} color="" />
                {c.title}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="lin-detail-actions">
        <Button variant="app" className="settings-button primary" onClick={startSession}>
          <Sparkles size={13} /> Assign to agent
        </Button>
        <a className="settings-button" href={row.url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={13} /> Open
        </a>
      </div>
      {detail && (
        <>
          <h4 className="lin-eyebrow">Comments · {detail.comments.length}</h4>
          {detail.comments.map((c) => (
            <div key={c.id} className="lin-comment">
              <span className="lin-muted">
                {c.author} · {c.createdAt.toLocaleString()}
              </span>
              <div className="linear-markdown">
                <Markdown text={c.body} />
              </div>
            </div>
          ))}
          <form
            className="lin-comment-form"
            onSubmit={(e) => {
              e.preventDefault()
              const body = comment.trim()
              if (!body) return
              void act(
                () => client.createComment({ issueId: row.id, body }),
                () => {
                  setComment('')
                  setDetail(undefined)
                },
              )
            }}
          >
            <Input
              className="settings-input"
              aria-label="Add a comment"
              placeholder="Add a comment…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              style={{ flex: 1 }}
            />
            <Button
              variant="app"
              className="settings-button"
              type="submit"
              disabled={busy || !comment.trim()}
            >
              Comment
            </Button>
          </form>
        </>
      )}
      {error && <small className="lin-bad">{error}</small>}
    </aside>
  )
}
