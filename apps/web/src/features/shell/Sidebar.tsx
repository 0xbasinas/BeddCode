import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  GitBranch,
  Monitor,
  PenSquare,
  Plus,
  Search,
  Server,
  Settings,
  Layers,
  X,
} from 'lucide-react'
import type { SessionView } from '@beddcode/client-runtime'
import { Dropdown } from '../../ui/Dropdown.tsx'
import { addProject, useAllSessions, useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { HostsDialog } from '../hosts/HostsDialog.tsx'
import { folderName, timeAgo } from '../../ui/format.ts'
import { useUiStore } from '../../stores/ui.ts'

type Filter = 'all' | 'needs-you' | 'done'

const PRIORITY: Record<SessionView['status'], number> = {
  'needs-you': 0,
  failed: 1,
  running: 2,
  idle: 3,
}

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

export function Sidebar() {
  const navigate = useNavigate()
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const [filter, setFilter] = useState<Filter>('all')
  const [hostsOpen, setHostsOpen] = useState(false)
  const [hostFilter, setHostFilter] = useState<string>('all')
  const [sort, setSort] = useState<'attention' | 'recent'>('attention')
  const searchOpen = useUiStore((s) => s.searchOpen)
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!searchOpen) return
    // A shortcut from Settings also mounts the composer, which normally takes initial focus.
    const frame = requestAnimationFrame(() => searchInput.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [searchOpen])
  const hosted = useAllSessions()
  const selectedHost = entries.some((e) => e.key === hostFilter) ? hostFilter : 'all'
  const all = hosted
    .filter((h) => selectedHost === 'all' || h.hostKey === selectedHost)
    .map((h) => h.session)
  const hostOf = new Map(hosted.map((h) => [h.session.id, h.hostKey]))
  const multiHost = entries.length > 1
  const online = entries.filter((e) => runtimes[e.key]?.connection === 'connected').length
  const local = runtimes[LOCAL_HOST_KEY]

  const needsYou = all.filter((s) => s.status === 'needs-you').length
  const visible = all
    .filter(
      (s) =>
        !searchOpen ||
        `${s.title} ${s.projectPath} ${s.branch ?? ''} ${activityLine(s)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .filter((s) =>
      filter === 'all'
        ? true
        : filter === 'needs-you'
          ? s.status === 'needs-you'
          : s.status === 'idle',
    )
    .sort(
      (a, b) =>
        (sort === 'attention' ? PRIORITY[a.status] - PRIORITY[b.status] : 0) ||
        b.updatedAt - a.updatedAt,
    )

  // Sessions of one repository sit together, whether they run in its checkout or a worktree.
  // The same path on two hosts is two different repositories.
  const groups = new Map<string, SessionView[]>()
  const groupKey = (s: SessionView) => `${hostOf.get(s.id)}
${s.projectPath}`
  for (const s of visible) groups.set(groupKey(s), [...(groups.get(groupKey(s)) ?? []), s])

  const tab = (id: Filter, label: string, count?: number) => (
    <button className="tab" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>
      {label}
      {count ? <span className="badge">{count}</span> : null}
    </button>
  )
  const agentLabel = (s: SessionView) =>
    runtimes[hostOf.get(s.id) ?? '']?.providers.find((p) => p.id === s.instanceId)?.label ??
    s.instanceId

  return (
    <aside className="panel sidebar">
      <div className="sidebar-top">
        <span className="brand">BeddCode</span>
        <Dropdown
          placement="bottom"
          align="end"
          trigger={({ open, toggle }) => (
            <button
              className="host-filter"
              onClick={toggle}
              aria-label="Hosts"
              aria-expanded={open}
            >
              <Monitor size={13} />
              <span>
                {selectedHost === 'all'
                  ? 'All hosts'
                  : (runtimes[selectedHost]?.host?.name ??
                    entries.find((e) => e.key === selectedHost)?.name)}
              </span>
              <ChevronDown size={10} />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="menu-heading">Show sessions from</div>
              <button
                className="menu-row"
                role="menuitemradio"
                aria-checked={selectedHost === 'all'}
                onClick={() => {
                  setHostFilter('all')
                  close()
                }}
              >
                <Monitor size={15} />
                <span className="menu-text">All hosts</span>
                {selectedHost === 'all' && <Check size={14} />}
              </button>
              {entries.map((entry) => (
                <button
                  key={entry.key}
                  className="menu-row"
                  role="menuitemradio"
                  aria-checked={selectedHost === entry.key}
                  onClick={() => {
                    setHostFilter(entry.key)
                    close()
                  }}
                >
                  {entry.key === LOCAL_HOST_KEY ? <Monitor size={15} /> : <Server size={15} />}
                  <span className="menu-text">{runtimes[entry.key]?.host?.name ?? entry.name}</span>
                  {selectedHost === entry.key && <Check size={14} />}
                </button>
              ))}
              <div className="menu-sep" />
              <button
                className="menu-row"
                onClick={() => {
                  close()
                  setHostsOpen(true)
                }}
              >
                <Server size={15} />
                Manage hosts
              </button>
            </>
          )}
        </Dropdown>
      </div>
      <div className="side-actions">
        <button className="row-btn" onClick={() => void navigate({ to: '/' })}>
          <PenSquare size={18} /> New session
        </button>
        <button
          className="icon-btn"
          aria-label="Search"
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen(!searchOpen)}
          title="Search sessions (Ctrl+K)"
        >
          <Search size={18} />
        </button>
        <AddFolder />
      </div>
      {searchOpen && (
        <div className="session-search">
          <Search size={14} />
          <input
            ref={searchInput}
            aria-label="Search sessions"
            placeholder="Search sessions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('')
                setSearchOpen(false)
              }
            }}
          />
          <button
            className="icon-btn"
            aria-label="Close search"
            onClick={() => {
              setQuery('')
              setSearchOpen(false)
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {all.length > 0 && (
        <div className="sidebar-filters">
          <div className="tabs" role="tablist" aria-label="Session status">
            {tab('all', `All ${all.length}`)}
            {tab('needs-you', 'Needs you', needsYou)}
            {tab('done', 'Done')}
          </div>
          <Dropdown
            placement="bottom"
            align="end"
            trigger={({ open, toggle }) => (
              <button
                className="sort-trigger"
                aria-label="Sort sessions"
                aria-expanded={open}
                onClick={toggle}
              >
                <ArrowDownWideNarrow size={12} />
                <span>{sort === 'attention' ? 'Attention first' : 'Recent first'}</span>
                <ChevronDown size={10} />
              </button>
            )}
          >
            {(close) => (
              <>
                {(['attention', 'recent'] as const).map((value) => (
                  <button
                    key={value}
                    className="menu-row"
                    role="menuitemradio"
                    aria-checked={sort === value}
                    onClick={() => {
                      setSort(value)
                      close()
                    }}
                  >
                    <span className="menu-text">
                      {value === 'attention' ? 'Attention first' : 'Recent first'}
                    </span>
                    {sort === value && <Check size={14} />}
                  </button>
                ))}
              </>
            )}
          </Dropdown>
        </div>
      )}

      <div className="session-list">
        {visible.length === 0 && (
          <div className="sidebar-empty">
            <span className="empty-icon">
              {searchOpen && query ? (
                <Search size={22} />
              ) : all.length === 0 ? (
                <Layers size={22} />
              ) : (
                <Check size={22} />
              )}
            </span>
            <h3>
              {searchOpen && query
                ? 'No matching sessions'
                : all.length === 0
                  ? 'No sessions yet'
                  : 'All caught up'}
            </h3>
            <p>
              {searchOpen && query
                ? 'Try another title, folder, or branch.'
                : local?.connection !== 'connected' && online === 0
                  ? 'Connecting to host…'
                  : all.length === 0
                    ? 'Sessions you start will appear here, grouped by folder.'
                    : 'No sessions need your attention right now.'}
            </p>
            {all.length === 0 && <AddFolder expanded />}
          </div>
        )}
        {[...groups].map(([key, list]) => {
          const project = list[0]!.projectPath
          const hostKey = hostOf.get(list[0]!.id) ?? LOCAL_HOST_KEY
          const hostName = hostKey === LOCAL_HOST_KEY ? 'This PC' : runtimes[hostKey]?.host?.name
          return (
            <section key={key}>
              <div className="group-title" title={project}>
                <Folder size={14} />
                <span className="group-name">{folderName(project)}</span>
                <span>{multiHost || hostName ? hostName : undefined}</span>
                <span className="spacer" />
                <button
                  className="icon-btn small"
                  aria-label={`New session in ${folderName(project)}`}
                  onClick={() => void navigate({ to: '/', search: { project, host: hostKey } })}
                >
                  <Plus size={15} />
                </button>
              </div>
              {list.map((s) => (
                <Link
                  key={s.id}
                  to="/session/$sessionId"
                  params={{ sessionId: s.id }}
                  activeOptions={{ exact: true, includeSearch: false }}
                  className="session-row"
                  activeProps={{ className: 'session-row active' }}
                >
                  {s.status === 'idle' && s.items.length > 0 && s.lastTurnReason !== 'cancelled' ? (
                    <Check className="session-done" size={12} />
                  ) : (
                    <span
                      className={`dot ${s.lastTurnReason === 'cancelled' ? 'cancelled' : s.status}`}
                    />
                  )}
                  <span className="session-main">
                    <span className="session-title">{s.title}</span>
                    <span className="session-sub">{activityLine(s)}</span>
                    <span className="session-branch">
                      {s.branch && (
                        <>
                          <GitBranch size={11} /> <code>{s.branch}</code> ·{' '}
                        </>
                      )}
                      {agentLabel(s)}
                    </span>
                  </span>
                  <span className="session-side">
                    <span className="session-time">{timeAgo(s.updatedAt)}</span>
                    {(s.added > 0 || s.removed > 0) && (
                      <span className="stat">
                        <span className="add">+{s.added}</span>{' '}
                        <span className="del">−{s.removed}</span>
                      </span>
                    )}
                  </span>
                </Link>
              ))}
            </section>
          )
        })}
      </div>

      <div className="sidebar-foot">
        <button
          className="row-btn"
          style={{ width: 'auto' }}
          onClick={() => void navigate({ to: '/settings' })}
        >
          <Settings size={18} /> Settings
        </button>
        <button className="link-btn" onClick={() => setHostsOpen(true)} title="Manage hosts">
          {multiHost
            ? `${online} of ${entries.length} hosts online`
            : local?.connection === 'connected'
              ? 'This PC online'
              : local?.connection === 'reconnecting'
                ? 'Reconnecting…'
                : 'Connecting…'}
        </button>
      </div>
      {hostsOpen && <HostsDialog onClose={() => setHostsOpen(false)} />}
    </aside>
  )
}

/** Adds a folder on a host to its projects list, then offers a session in it. */
function AddFolder({ expanded = false }: { expanded?: boolean }) {
  const navigate = useNavigate()
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const [hostKey, setHostKey] = useState(LOCAL_HOST_KEY)
  const [error, setError] = useState<string>()
  return (
    <Dropdown
      placement="bottom"
      align="end"
      panelClassName="wide"
      trigger={({ toggle }) => (
        <button
          className={expanded ? 'empty-action' : 'icon-btn'}
          aria-label="Add folder"
          onClick={toggle}
        >
          <FolderPlus size={expanded ? 14 : 18} />
          {expanded && 'Add a folder'}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-heading">
            {entries.length > 1 ? 'Add a folder on' : 'Add a folder on this host'}
          </div>
          {entries.length > 1 && (
            <select
              className="path-input"
              value={hostKey}
              onChange={(e) => setHostKey(e.target.value)}
              aria-label="Host"
            >
              {entries.map((e) => (
                <option
                  key={e.key}
                  value={e.key}
                  disabled={runtimes[e.key]?.connection !== 'connected'}
                >
                  {runtimes[e.key]?.host?.name ?? e.name}
                </option>
              ))}
            </select>
          )}
          <input
            className="path-input"
            placeholder="Absolute path, e.g. C:\src\my-app"
            autoFocus
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const value = e.currentTarget.value.trim()
              if (!value) return
              addProject(hostKey, value).then(
                (project) => {
                  close()
                  void navigate({ to: '/', search: { project: project.path, host: hostKey } })
                },
                (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
              )
            }}
          />
          {error && <div className="composer-error menu-error">{error}</div>}
        </>
      )}
    </Dropdown>
  )
}
