import { Select } from '../../ui/Select.tsx'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  LinearClient,
  PaginationOrderBy,
  type Issue,
  type Team,
  type WorkflowState,
} from '@linear/sdk'
import {
  CircleCheck,
  ChevronRight,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogOut,
  Play,
  Plus,
  RefreshCw,
} from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { setHandoff } from '../../stores/handoff.ts'
import { hostRequest } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import '../settings/settings.css'
import './linear.css'

const KEY_STORAGE = 'beddcode.linear-api-key'

type Tab = 'mine' | 'team' | 'cycle'

interface IssueRow {
  issue: Issue
  id: string
  identifier: string
  title: string
  url: string
  priorityLabel: string
  state: string
  stateId?: string
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

interface Detail {
  description: string
  branchName: string
  comments: Comment[]
  states: WorkflowState[]
}

interface Loaded {
  name: string
  email: string
  org: string
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
    priorityLabel: issue.priorityLabel,
    state: state?.name ?? '',
    stateId: state?.id,
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
  const [adding, setAdding] = useState(false)
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
        setData({ name: me.displayName, email: me.email, org: org.name, teams: teams.nodes })
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
    setAdding(false)
  }
  const removeAccount = () => {
    if (!account) return
    const accounts = store.accounts.filter((a) => a.id !== account.id)
    update({ accounts, active: accounts[0]?.id ?? '' })
    setData(undefined)
    setError(undefined)
  }

  const keyForm = (
    <form
      className="setting-row"
      onSubmit={(e) => {
        e.preventDefault()
        submitKey()
      }}
    >
      <KeyRound size={16} />
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
      {account && (
        <Button
          variant="app"
          className="settings-button"
          type="button"
          onClick={() => setAdding(false)}
        >
          Cancel
        </Button>
      )}
    </form>
  )

  return (
    <main className="panel settings-main linear-page">
      <div className="settings-content linear-content">
        <header className="settings-heading">
          <h2>Linear</h2>
        </header>
        {!client ? (
          <div className="settings-card">
            <div className="setting-row">
              <span className="setting-label">
                <strong>Connect Linear</strong>
                <span className="settings-value">
                  Paste a personal API key from Linear → Settings → Security. It stays on this
                  device.
                </span>
              </span>
            </div>
            {keyForm}
          </div>
        ) : (
          <>
            <div className="settings-card linear-account-card">
              <div className="setting-row linear-account-row">
                <span className="linear-avatar" aria-hidden="true">
                  {(data?.org ?? account?.label ?? 'L').charAt(0).toUpperCase()}
                </span>
                <span className="setting-label">
                  <strong>{data ? data.org : 'Linear workspace'}</strong>
                  <span className="settings-value">
                    {data
                      ? `Connected as ${data.name} · ${data.email}`
                      : error
                        ? 'Not connected'
                        : 'Connecting…'}
                  </span>
                </span>
                {store.accounts.length > 1 && (
                  <Select
                    className="settings-input"
                    aria-label="Linear account"
                    value={account?.id}
                    onChange={(e) => update({ ...store, active: e.target.value })}
                  >
                    {store.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </Select>
                )}
                <Button
                  variant="app"
                  className="settings-button"
                  onClick={() => setAdding((v) => !v)}
                >
                  <Plus size={14} /> Add account
                </Button>
                <Button variant="app" className="settings-button danger" onClick={removeAccount}>
                  <LogOut size={14} /> Remove
                </Button>
              </div>
              {adding && keyForm}
            </div>
            {error && <ErrorCard title="Could not load Linear" text={error} />}
            {data && <Workspace key={apiKey} client={client} teams={data.teams} />}
          </>
        )}
      </div>
    </main>
  )
}

function ErrorCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="settings-card">
      <div className="setting-row" role="alert">
        <span className="setting-label">
          <strong>{title}</strong>
          <span className="settings-value">{text}</span>
        </span>
      </div>
    </div>
  )
}

function Workspace({ client, teams }: { client: LinearClient; teams: Team[] }) {
  const [tab, setTab] = useState<Tab>('mine')
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<IssueRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [note, setNote] = useState<string>()
  const [creating, setCreating] = useState(false)

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
        const cycle = await team.activeCycle
        if (cycle) {
          setNote(
            `${cycle.name ?? `Cycle ${cycle.number}`} · ${Math.round(cycle.progress * 100)}% done · ends ${cycle.endsAt.toLocaleDateString()}`,
          )
          issues = (await cycle.issues({ first: 100 })).nodes
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

  const grouped = useMemo(() => {
    const byState = new Map<string, IssueRow[]>()
    for (const row of rows) {
      const list = byState.get(row.state)
      if (list) list.push(row)
      else byState.set(row.state, [row])
    }
    return [...byState]
  }, [rows])
  const overdue = rows.filter(
    (r) => r.dueDate && new Date(r.dueDate) < new Date(new Date().toDateString()),
  ).length

  return (
    <div className="linear-workspace">
      <div className="settings-card linear-toolbar-card">
        <div className="setting-row linear-bar">
          <Tabs className="gap-0" value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList
              className="tabs h-auto w-auto justify-start rounded-none bg-transparent p-0"
              aria-label="Linear views"
            >
              {(
                [
                  ['mine', 'Assigned to me'],
                  ['team', 'Team issues'],
                  ['cycle', 'Current cycle'],
                ] as const
              ).map(([id, label]) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="tab h-auto flex-none border-0 shadow-none focus-visible:ring-0"
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <span style={{ flex: 1 }} />
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
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? <LoaderCircle size={14} /> : <RefreshCw size={14} />} Refresh
          </Button>
          <Button
            variant="app"
            className="settings-button primary"
            onClick={() => setCreating((c) => !c)}
          >
            <Plus size={14} /> New issue
          </Button>
        </div>
        {tab === 'team' && (
          <div className="setting-row">
            <Input
              className="settings-input"
              aria-label="Search issue titles"
              placeholder="Search titles in this team…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
        )}
        {note && (
          <div className="setting-row">
            <span className="settings-value">{note}</span>
          </div>
        )}
      </div>
      {creating && (
        <NewIssue
          client={client}
          teams={teams}
          defaultTeam={teamId}
          onCancel={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            void refresh()
          }}
        />
      )}
      {error && <ErrorCard title="Could not load issues" text={error} />}
      <div className="linear-scroll">
        {!loading && !error && rows.length === 0 && !note && (
          <div className="settings-card linear-empty-state">
            <span className="linear-empty-icon">
              <CircleCheck size={19} />
            </span>
            <strong>{tab === 'mine' ? 'You’re all caught up' : 'No open issues found'}</strong>
            <span className="settings-value">
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
        {rows.length > 0 && (
          <p className="settings-value">
            {rows.length} {rows.length === 1 ? 'issue' : 'issues'}
            {overdue ? ` · ${overdue} overdue` : ''}
          </p>
        )}
        {grouped.map(([state, list]) => (
          <section key={state}>
            <h3 className="linear-group">
              {state} <span>{list.length}</span>
            </h3>
            <div className="settings-card">
              {list.map((row) => (
                <IssueItem
                  key={row.id}
                  client={client}
                  row={row}
                  onChanged={() => void refresh()}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function NewIssue({
  client,
  teams,
  defaultTeam,
  onCancel,
  onDone,
}: {
  client: LinearClient
  teams: Team[]
  defaultTeam: string
  onCancel(): void
  onDone(): void
}) {
  const [teamId, setTeamId] = useState(defaultTeam)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await client.createIssue({
        teamId,
        title: title.trim(),
        description: description.trim() || undefined,
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
    <form
      className="settings-card"
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
      <div className="setting-row">
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
        <Input
          className="settings-input"
          aria-label="Issue title"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ flex: 1 }}
        />
      </div>
      <div className="setting-row">
        <Textarea
          className="settings-input"
          aria-label="Issue description"
          placeholder="Description (markdown)"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ flex: 1 }}
        />
      </div>
      <div className="setting-row">
        {error && <span className="settings-value">{error}</span>}
        <span style={{ flex: 1 }} />
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
  )
}

function IssueItem({
  client,
  row,
  onChanged,
}: {
  client: LinearClient
  row: IssueRow
  onChanged(): void
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<Detail>()
  const [error, setError] = useState<string>()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)

  const loadDetail = useCallback(async () => {
    try {
      const [team, comments] = await Promise.all([row.issue.team, row.issue.comments()])
      const [states, authors] = await Promise.all([
        team ? team.states() : undefined,
        Promise.all(comments.nodes.map((c) => c.user)),
      ])
      setDetail({
        description: row.issue.description ?? '',
        branchName: row.issue.branchName,
        states: states?.nodes ?? [],
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
    if (open && !detail) void loadDetail()
  }, [open, detail, loadDetail])

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

  const overdue = Boolean(
    row.dueDate && new Date(row.dueDate) < new Date(new Date().toDateString()),
  )
  return (
    <div className="linear-issue">
      <button className="setting-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={14} className={`linear-chevron ${open ? 'open' : ''}`} />
        <span className="setting-label">
          <span className="linear-title">
            <span className="linear-id">{row.identifier}</span>
            <strong>{row.title}</strong>
          </span>
          <span className="linear-chips">
            {row.priorityLabel !== 'No priority' && (
              <span className={`linear-chip priority-${row.issue.priority}`}>
                {row.priorityLabel}
              </span>
            )}
            {row.project && <span className="linear-chip">{row.project}</span>}
            {row.cycle && <span className="linear-chip">{row.cycle}</span>}
            {row.estimate != null && <span className="linear-chip">{row.estimate} pts</span>}
            {row.dueDate && (
              <span className={`linear-chip ${overdue ? 'overdue' : ''}`}>Due {row.dueDate}</span>
            )}
            {row.labels.map((l) => (
              <span key={l} className="linear-chip label">
                {l}
              </span>
            ))}
            {row.assignee && <span className="linear-chip faint">{row.assignee}</span>}
            <span className="linear-chip faint">Updated {row.updatedAt.toLocaleDateString()}</span>
          </span>
        </span>
      </button>
      {open && (
        <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {!detail && !error && <span className="settings-value">Loading…</span>}
          {detail && (
            <>
              {detail.description ? (
                <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{detail.description}</p>
              ) : (
                <span className="settings-value">No description.</span>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Select
                  className="settings-input"
                  aria-label="Status"
                  value={row.stateId}
                  disabled={busy}
                  onChange={(e) =>
                    void act(
                      () => client.updateIssue(row.id, { stateId: e.target.value }),
                      onChanged,
                    )
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
                <Button variant="app" className="settings-button primary" onClick={startSession}>
                  <Play size={14} /> Start session
                </Button>
                <a
                  className="settings-button"
                  href={row.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={14} /> Open in Linear
                </a>
              </div>
              <strong>Comments · {detail.comments.length}</strong>
              {detail.comments.map((c) => (
                <div key={c.id}>
                  <span className="settings-value">
                    {c.author} · {c.createdAt.toLocaleString()}
                  </span>
                  <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{c.body}</p>
                </div>
              ))}
              <form
                style={{ display: 'flex', gap: 8 }}
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
          {error && <span className="settings-value">{error}</span>}
        </div>
      )}
    </div>
  )
}
