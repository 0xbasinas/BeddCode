import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { FolderPlus, GitBranch, Plus, PenSquare, Search, Settings } from 'lucide-react'
import type { SessionView } from '@beddcode/client-runtime'
import { Dropdown } from '../../ui/Dropdown.tsx'
import { useHostStore } from '../../stores/host.ts'
import { folderName, timeAgo } from '../../ui/format.ts'

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
      return s.items.length === 0
        ? 'No messages yet'
        : s.added + s.removed > 0
          ? 'Done · changes ready'
          : 'Done'
  }
}

export function Sidebar() {
  const navigate = useNavigate()
  const { replica, host, connection, providers } = useHostStore()
  const [filter, setFilter] = useState<Filter>('all')
  const all = replica.order.map((id) => replica.sessions[id]!)

  const needsYou = all.filter((s) => s.status === 'needs-you').length
  const visible = all
    .filter((s) =>
      filter === 'all'
        ? true
        : filter === 'needs-you'
          ? s.status === 'needs-you'
          : s.status === 'idle',
    )
    .sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status] || b.updatedAt - a.updatedAt)

  // Sessions of one repository sit together, whether they run in its checkout or a worktree.
  const groups = new Map<string, SessionView[]>()
  for (const s of visible) groups.set(s.projectPath, [...(groups.get(s.projectPath) ?? []), s])

  const tab = (id: Filter, label: string, count?: number) => (
    <button className="tab" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>
      {label}
      {count ? <span className="badge">{count}</span> : null}
    </button>
  )
  const agentLabel = (id: string) => providers.find((p) => p.id === id)?.label ?? id

  return (
    <aside className="panel sidebar">
      <span className="brand">BeddCode</span>
      <div className="side-actions">
        <button className="row-btn" onClick={() => void navigate({ to: '/' })}>
          <PenSquare size={18} /> New session
        </button>
        <button className="icon-btn" aria-label="Search" disabled title="Search arrives later">
          <Search size={18} />
        </button>
        <AddFolder />
      </div>
      <div className="tabs" role="tablist">
        {tab('all', `All ${all.length}`)}
        {tab('needs-you', 'Needs you', needsYou)}
        {tab('done', 'Done')}
      </div>

      <div className="session-list">
        {visible.length === 0 && (
          <div className="sidebar-empty">
            <div>{all.length === 0 ? 'No sessions yet' : 'Nothing here'}</div>
            <div style={{ color: 'var(--text-faint)' }}>
              {connection !== 'connected'
                ? 'Connecting to host…'
                : all.length === 0
                  ? 'Start a new session'
                  : 'All caught up'}
            </div>
          </div>
        )}
        {[...groups].map(([project, list]) => (
          <section key={project}>
            <div className="group-title" title={project}>
              <span className="group-name">{folderName(project)}</span>
              <span>{host?.name}</span>
              <span className="spacer" />
              <button
                className="icon-btn small"
                aria-label={`New session in ${folderName(project)}`}
                onClick={() => void navigate({ to: '/', search: { project } })}
              >
                <Plus size={15} />
              </button>
            </div>
            {list.map((s) => (
              <Link
                key={s.id}
                to="/session/$sessionId"
                params={{ sessionId: s.id }}
                className="session-row"
                activeProps={{ className: 'session-row active' }}
              >
                <span className={`dot ${s.status}`} />
                <span className="session-main">
                  <span className="session-title">{s.title}</span>
                  <span className="session-sub">{activityLine(s)}</span>
                  <span className="session-branch">
                    {s.branch && (
                      <>
                        <GitBranch size={11} /> <code>{s.branch}</code> ·{' '}
                      </>
                    )}
                    {agentLabel(s.instanceId)}
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
        ))}
      </div>

      <div className="sidebar-foot">
        <button className="row-btn" style={{ width: 'auto' }}>
          <Settings size={18} /> Settings
        </button>
        <span>
          {connection === 'connected'
            ? `${host?.name ?? 'Host'} online`
            : connection === 'reconnecting'
              ? 'Reconnecting…'
              : 'Connecting…'}
        </span>
      </div>
    </aside>
  )
}

/** Adds a folder on the host to the projects list, then offers a session in it. */
function AddFolder() {
  const navigate = useNavigate()
  const [error, setError] = useState<string>()
  return (
    <Dropdown
      placement="bottom"
      align="end"
      panelClassName="wide"
      trigger={({ toggle }) => (
        <button className="icon-btn" aria-label="Add folder" onClick={toggle}>
          <FolderPlus size={18} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-heading">Add a folder on this host</div>
          <input
            className="path-input"
            placeholder="Absolute path, e.g. C:\src\my-app"
            autoFocus
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const value = e.currentTarget.value.trim()
              if (!value) return
              useHostStore
                .getState()
                .addProject(value)
                .then(
                  (project) => {
                    close()
                    void navigate({ to: '/', search: { project: project.path } })
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
