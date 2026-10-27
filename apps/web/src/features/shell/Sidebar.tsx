import { AgentIcon } from '../../ui/AgentMark.tsx'
import {
  Fragment,
  useCallback,
  useEffect,
  useDeferredValue,
  useMemo,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  ArrowDownWideNarrow,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  GitBranch,
  Monitor,
  PenSquare,
  Plus,
  Search,
  Server,
  Layers,
  MessageSquare,
  Undo2,
  Bot,
  CalendarClock,
  History,
  Pin,
  PinOff,
  Trash2,
  X,
} from 'lucide-react'
import {
  activityLine,
  doneMenuAction,
  doneOpen,
  isFiledAway,
  nestSessions,
  searchSessions,
  sessionNote,
  splitDone,
  type SessionView,
} from '@beddcode/client-runtime'
import type { Project } from '@beddcode/contracts'
import { ContextMenu, type ContextMenuItem } from '../../ui/ContextMenu.tsx'
import { Dropdown } from '../../ui/Dropdown.tsx'
import {
  reconnectHostNow,
  setSessionDone,
  deleteSession,
  setSessionPinned,
  useAllSessions,
  useHostStore,
} from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { HostsDialog } from '../hosts/HostsDialog.tsx'
import { HistoryDialog } from '../history/HistoryDialog.tsx'
import { folderName, timeAgo } from '../../ui/format.ts'
import { useUiStore } from '../../stores/ui.ts'
import { AddFolderMenu } from '../folders/AddFolderMenu.tsx'
import { Logo } from '../../ui/Logo.tsx'
import { isFresh, useFolderFlow } from '../folders/folderFlow.ts'
import { foldersWithoutSessions, samePath } from '../folders/folderLogic.ts'

type Filter = 'all' | 'needs-you' | 'done'

const PRIORITY: Record<SessionView['status'], number> = {
  'needs-you': 0,
  failed: 1,
  running: 2,
  idle: 3,
}

/** A host's connection in a word, and the colour of its dot. */
function hostState(connection: string | undefined): { label: string; tone: string } {
  switch (connection) {
    case 'connected':
      return { label: 'Online', tone: 'ok' }
    case 'connecting':
      return { label: 'Connecting…', tone: 'warn' }
    case 'reconnecting':
      return { label: 'Reconnecting…', tone: 'warn' }
    case 'denied':
      return { label: 'Needs pairing', tone: 'failed' }
    default:
      return { label: 'Offline', tone: 'failed' }
  }
}

const OPEN_DONE_KEY = 'beddcode.done-open'
const COLLAPSED_PROJECTS_KEY = 'beddcode.collapsed-projects'

/** Section choices remembered per host and folder between runs. */
function useRememberedSections(storageKey: string): [Set<string>, (key: string) => void] {
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
      return new Set(
        Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string') : [],
      )
    } catch {
      return new Set()
    }
  })
  const toggle = useCallback(
    (key: string) => {
      setOpen((current) => {
        const next = new Set(current)
        if (!next.delete(key)) next.add(key)
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]))
        } catch {
          // Still works for this window.
        }
        return next
      })
    },
    [storageKey],
  )
  return [open, toggle]
}

export function Sidebar() {
  const navigate = useNavigate()
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const [filter, setFilter] = useState<Filter>('all')
  const [hostsOpen, setHostsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [hostFilter, setHostFilter] = useState<string>('all')
  const [sort, setSort] = useState<'attention' | 'recent'>('attention')
  const searchOpen = useUiStore((s) => s.searchOpen)
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const sessionList = useRef<HTMLDivElement>(null)
  const onSearchKey = (event: KeyboardEvent<HTMLElement>) => {
    if (
      !searchOpen ||
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
      setSearchOpen(false)
      return
    }
    if (event.target !== searchInput.current && !(event.target as Element).closest('.session-row'))
      return
    const rows = Array.from(
      sessionList.current?.querySelectorAll<HTMLAnchorElement>('.session-row') ?? [],
    )
    const at = rows.indexOf(document.activeElement as HTMLAnchorElement)
    if (event.key === 'Enter') {
      event.stopPropagation()
      if (event.target === searchInput.current) {
        event.preventDefault()
        rows[0]?.click()
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = event.key === 'ArrowDown' ? at + 1 : at < 0 ? rows.length - 1 : at - 1
      if (next < 0 || !rows.length) searchInput.current?.focus()
      else {
        const row = rows[next % rows.length]!
        row.focus({ preventScroll: true })
        row.scrollIntoView({ block: 'nearest' })
      }
    }
  }
  /** The right-click menu: where it opened, and for which session. */
  const [menu, setMenu] = useState<{ x: number; y: number; session: SessionView } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [openDone, toggleDone] = useRememberedSections(OPEN_DONE_KEY)
  const [collapsedProjects, toggleProject] = useRememberedSections(COLLAPSED_PROJECTS_KEY)
  const openId = useRouterState({
    select: (r) => /^\/session\/([^/]+)/.exec(r.location.pathname)?.[1],
  })
  useEffect(() => {
    if (!searchOpen) return
    // A shortcut from Settings also mounts the composer, which normally takes initial focus.
    const frame = requestAnimationFrame(() => searchInput.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [searchOpen])
  const hosted = useAllSessions()
  const deferredHosted = useDeferredValue(hosted)
  const deferredQuery = useDeferredValue(query)
  const selectedHost = entries.some((e) => e.key === hostFilter) ? hostFilter : 'all'
  const all = hosted
    .filter((h) => selectedHost === 'all' || h.hostKey === selectedHost)
    .map((h) => h.session)
  const hostOf = new Map(hosted.map((h) => [h.session.id, h.hostKey]))
  const online = entries.filter((e) => runtimes[e.key]?.connection === 'connected').length
  const local = runtimes[LOCAL_HOST_KEY]

  const needsYou = all.filter((s) => s.status === 'needs-you').length
  const searching = searchOpen && query.trim() !== ''
  // Searching looks at what was said in each session too, and shows the matching words.
  const messageHits = useMemo(
    () =>
      new Map(
        searching
          ? searchSessions(
              deferredHosted
                .filter((h) => selectedHost === 'all' || h.hostKey === selectedHost)
                .map((h) => h.session),
              deferredQuery,
              { limit: 500, snippetChars: 44 },
            )
              .filter((m) => m.field === 'message')
              .map((m) => [m.sessionId, m])
          : [],
      ),
    [searching, deferredHosted, deferredQuery, selectedHost],
  )
  const visible = all
    .filter(
      (s) =>
        !searching ||
        messageHits.has(s.id) ||
        `${s.title} ${s.projectless ? 'No project' : s.projectPath} ${s.branch ?? ''} ${activityLine(s)}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    )
    .filter((s) =>
      filter === 'all' ? true : filter === 'needs-you' ? s.status === 'needs-you' : isFiledAway(s),
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
${s.projectless ? 'no-project' : s.projectPath}`
  // Pinned sessions sit in their own section at the top (outside the Done tab and searches).
  const showPinned = filter !== 'done' && !searching
  const pinned = showPinned ? visible.filter((s) => s.pinned) : []
  for (const s of visible) {
    if (showPinned && s.pinned) continue
    const key = groupKey(s)
    const group = groups.get(key)
    if (group) group.push(s)
    else groups.set(key, [s])
  }

  // Added folders show up straight away, before any session runs in them.
  const sessionGroups = [...groups].map(([key, list]) => ({
    key,
    hostKey: hostOf.get(list[0]!.id) ?? LOCAL_HOST_KEY,
    projectPath: list[0]!.projectless ? '' : list[0]!.projectPath,
    projectless: list[0]!.projectless,
    list,
  }))
  const projectsOf = (hostKey: string): Project[] => runtimes[hostKey]?.projects ?? []
  const emptyFolders =
    filter === 'all' && !(searchOpen && query)
      ? foldersWithoutSessions(
          entries
            .filter((e) => selectedHost === 'all' || e.key === selectedHost)
            .flatMap((e) => projectsOf(e.key).map((project) => ({ hostKey: e.key, project }))),
          sessionGroups,
        )
      : []
  const hasFolders = entries.some((e) => projectsOf(e.key).length > 0)
  const hostLabel = (hostKey: string) =>
    hostKey === LOCAL_HOST_KEY ? 'This PC' : (runtimes[hostKey]?.host?.name ?? 'Remote host')

  const sessionRow = (s: SessionView, depth = 0) => {
    const note = sessionNote(s)
    return (
      <Link
        key={s.id}
        to="/session/$sessionId"
        params={{ sessionId: s.id }}
        data-status={s.status}
        activeOptions={{ exact: true, includeSearch: false }}
        className={depth > 0 ? 'session-row child' : 'session-row'}
        style={depth > 0 ? { ['--nest' as string]: Math.min(depth, 3) } : undefined}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, session: s })
        }}
        activeProps={{ className: 'session-row active' }}
        onClick={() => {
          if (searchOpen) {
            setQuery('')
            setSearchOpen(false)
          }
        }}
      >
        {s.status === 'idle' && s.items.length > 0 && s.lastTurnReason !== 'cancelled' ? (
          <Check className="session-done" size={12} />
        ) : (
          <span
            className={`dot ${s.status === 'idle' && s.lastTurnReason === 'cancelled' ? 'cancelled' : s.status}`}
            title={s.status === 'running' ? 'Working' : undefined}
            role={s.status === 'running' ? 'img' : undefined}
            aria-label={s.status === 'running' ? 'Working' : undefined}
          />
        )}
        <span className="session-main">
          <span className="session-top">
            <span className="session-title" title={s.title}>
              {s.title}
            </span>
            <span className="session-time">{timeAgo(s.updatedAt)}</span>
          </span>
          <span className="session-meta">
            {note && !(s.status === 'running' && note === 'Working…') && (
              <span className={`session-note ${s.status}`} title={note}>
                {note}
              </span>
            )}
            <span
              className="session-where"
              title={[s.branch, agentLabel(s)].filter(Boolean).join(' · ')}
            >
              {s.branch && (
                <>
                  <GitBranch size={11} /> <code>{s.branch}</code> ·{' '}
                </>
              )}
              {s.schedule && (
                <CalendarClock size={11} aria-label={`Scheduled: ${s.schedule.name}`} />
              )}
              {s.parent && <Bot size={11} aria-label="Started by another session" />}
              <AgentIcon agent={s.instanceId} label={agentLabel(s)} size={11} />
              {agentLabel(s)}
            </span>
            {s.pinned && !showPinned && (
              <Pin className="session-pin" size={11} aria-label="Pinned" />
            )}
            {(s.added > 0 || s.removed > 0) && (
              <span className="stat">
                <span className="add">+{s.added}</span> <span className="del">−{s.removed}</span>
              </span>
            )}
          </span>
          {messageHits.get(s.id)?.snippet && (
            <span className="session-snippet" title={messageHits.get(s.id)?.snippet}>
              {messageHits.get(s.id)?.role === 'user' ? 'You: ' : ''}
              {messageHits.get(s.id)?.snippet}
            </span>
          )}
        </span>
      </Link>
    )
  }

  /** A folder's sessions: the list, then its Done section (closed until asked for). */
  const renderGroup = (list: SessionView[], groupKey: string) => {
    // On the Done tab the filed sessions are the list itself.
    const rows = (sessions: SessionView[]) =>
      nestSessions(sessions).map(({ session, depth }) => sessionRow(session, depth))
    if (filter === 'done') return rows(list)
    const { active, done } = splitDone(list)
    const open = doneOpen({
      chosen: openDone.has(groupKey),
      searching: searchOpen && query !== '',
      activeId: openId,
      done,
    })
    return (
      <>
        {rows(active)}
        {done.length > 0 && (
          <>
            <button
              className="done-toggle"
              aria-expanded={open}
              onClick={() => toggleDone(groupKey)}
            >
              <ChevronRight size={13} className={open ? 'open' : undefined} />
              Done <span>{done.length}</span>
            </button>
            {open && rows(done)}
          </>
        )}
      </>
    )
  }

  const menuItems = (session: SessionView): ContextMenuItem[] => {
    const action = doneMenuAction(session)
    return [
      {
        id: 'done',
        label: action.label,
        hint: action.hint,
        icon: action.kind === 'restore' ? <Undo2 size={15} /> : <CheckCheck size={15} />,
        disabled: action.kind === 'busy',
        onSelect: () => void setSessionDone(session.id, action.kind === 'file'),
      },
      {
        id: 'pin',
        label: session.pinned ? 'Unpin' : 'Pin to top',
        icon: session.pinned ? <PinOff size={15} /> : <Pin size={15} />,
        onSelect: () => void setSessionPinned(session.id, !session.pinned),
      },
      {
        id: 'delete',
        label: 'Delete',
        hint: 'Removes the conversation. Your folder and files stay.',
        icon: <Trash2 size={15} />,
        onSelect: () => {
          if (!window.confirm(`Delete "${session.title}"? This cannot be undone.`)) return
          void deleteSession(session.id).then(
            () => {
              if (openId === session.id) void navigate({ to: '/' })
            },
            (err: unknown) => window.alert(err instanceof Error ? err.message : String(err)),
          )
        },
      },
    ]
  }

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
        <span className="brand">
          <Logo size={20} />
          BeddCode
        </span>
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
                <Fragment key={entry.key}>
                  <button
                    className="menu-row"
                    role="menuitemradio"
                    aria-checked={selectedHost === entry.key}
                    onClick={() => {
                      setHostFilter(entry.key)
                      close()
                    }}
                  >
                    {entry.key === LOCAL_HOST_KEY ? <Monitor size={15} /> : <Server size={15} />}
                    <span className="menu-text">
                      {runtimes[entry.key]?.host?.name ?? entry.name}
                    </span>
                    <span
                      className={`host-status ${hostState(runtimes[entry.key]?.connection).tone}`}
                    >
                      <span className="dot" />
                      {hostState(runtimes[entry.key]?.connection).label}
                    </span>
                    {selectedHost === entry.key && <Check size={14} />}
                  </button>
                  {entry.key !== LOCAL_HOST_KEY &&
                    ['connecting', 'reconnecting'].includes(
                      runtimes[entry.key]?.connection ?? '',
                    ) && (
                      <div className="menu-detail">
                        <span>Messages you send go out when it is back.</span>
                        <button onClick={() => reconnectHostNow(entry.key)}>Retry now</button>
                      </div>
                    )}
                </Fragment>
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
        <button
          className="row-btn"
          onClick={() => void navigate({ to: '/', search: { compose: true } })}
        >
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
      </div>
      <div className="folders-head">
        Folders
        <span className="folders-actions">
          <button
            className="icon-btn"
            aria-label="Resume an earlier conversation"
            title="Resume a conversation from the agent's own CLI"
            onClick={() => setHistoryOpen(true)}
          >
            <History size={16} />
          </button>
          <AddFolderMenu />
        </span>
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
            onKeyDown={onSearchKey}
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
            {tab('all', `All ${all.filter((s) => !isFiledAway(s)).length}`)}
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

      <div className="session-list" ref={sessionList} onKeyDown={onSearchKey}>
        {pinned.length > 0 && (
          <section className="pinned-group" aria-label="Pinned sessions">
            <div className="pinned-head">
              <Pin size={13} /> Pinned
            </div>
            {pinned.map((s) => sessionRow(s))}
          </section>
        )}
        {sessionGroups.length === 0 && emptyFolders.length === 0 && pinned.length === 0 && (
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
                  ? hasFolders
                    ? 'No sessions yet'
                    : 'No folders yet'
                  : 'All caught up'}
            </h3>
            <p>
              {searchOpen && query
                ? 'Try other words from a title, folder, branch, or message.'
                : local?.connection !== 'connected' && online === 0
                  ? 'Connecting to host…'
                  : all.length === 0
                    ? hasFolders
                      ? 'Sessions you start will appear here, grouped by folder.'
                      : 'Start a session without a project, or add a folder to work in.'
                    : 'No sessions need your attention right now.'}
            </p>
          </div>
        )}
        {sessionGroups.map(({ key, hostKey, projectPath, projectless, list }) => (
          <FolderGroup
            key={key}
            hostKey={hostKey}
            path={projectPath}
            projectless={projectless}
            project={projectsOf(hostKey).find((p) => samePath(p.path, projectPath))}
            hostName={entries.length > 1 ? hostLabel(hostKey) : undefined}
            collapsed={!searching && collapsedProjects.has(key)}
            onToggle={() => toggleProject(key)}
            sessionCount={list.length}
            workingCount={list.filter((s) => s.status === 'running').length}
          >
            {renderGroup(list, key)}
          </FolderGroup>
        ))}
        {emptyFolders.map(({ hostKey, project }) => (
          <FolderGroup
            key={`${hostKey}\n${project.path}`}
            hostKey={hostKey}
            path={project.path}
            project={project}
            hostName={entries.length > 1 ? hostLabel(hostKey) : undefined}
            collapsed={collapsedProjects.has(`${hostKey}\n${project.path}`)}
            onToggle={() => toggleProject(`${hostKey}\n${project.path}`)}
          />
        ))}
      </div>

      {hostsOpen && <HostsDialog onClose={() => setHostsOpen(false)} />}
      {historyOpen && (
        <HistoryDialog
          hostKey={selectedHost === 'all' ? LOCAL_HOST_KEY : selectedHost}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`${menu.session.title}`}
          items={menuItems(menu.session)}
          onClose={closeMenu}
        />
      )}
    </aside>
  )
}

/**
 * One folder in the sidebar: its collapsible name and host, then its sessions. A
 * folder without sessions yet offers to start one; a folder just added is marked New, and one
 * picked again while already here lights up briefly.
 */
function FolderGroup({
  hostKey,
  path,
  projectless,
  project,
  hostName,
  collapsed,
  onToggle,
  sessionCount,
  workingCount = 0,
  children,
}: {
  hostKey: string
  path: string
  projectless?: boolean
  project?: Project
  hostName?: string
  collapsed: boolean
  onToggle(): void
  sessionCount?: number
  workingCount?: number
  children?: ReactNode
}) {
  const navigate = useNavigate()
  const contentId = useId()
  const fresh = useFolderFlow((s) => isFresh(s.fresh, hostKey, path))
  const highlight = useFolderFlow((s) => s.highlight)
  const flashing = highlight?.hostKey === hostKey && samePath(highlight.path, path)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!flashing || !highlight) return
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const timer = setTimeout(() => {
      if (useFolderFlow.getState().highlight?.id === highlight.id)
        useFolderFlow.setState({ highlight: undefined })
    }, 2400)
    return () => clearTimeout(timer)
  }, [flashing, highlight])
  const name = projectless ? 'No project' : (project?.name ?? folderName(path))
  const empty = !children
  const startHere = () =>
    void navigate({
      to: '/',
      search: projectless ? { host: hostKey, compose: true } : { project: path, host: hostKey },
    })
  return (
    <section
      ref={ref}
      className={`folder-group ${flashing ? 'flash' : fresh && empty ? 'fresh' : ''}`}
    >
      <div className="group-title" title={projectless ? 'Sessions without a project folder' : path}>
        <button
          className="folder-toggle"
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${projectless ? 'sessions without a project' : `project ${name}`}`}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          aria-describedby={collapsed && workingCount > 0 ? `${contentId}-working` : undefined}
          onClick={onToggle}
        >
          <ChevronRight size={12} className={`folder-chevron ${collapsed ? '' : 'open'}`} />
          {projectless ? (
            <MessageSquare size={14} />
          ) : project && !project.isRepo ? (
            <Folder size={14} />
          ) : (
            <FolderGit2 size={14} />
          )}
          <span className="group-name">{name}</span>
          {collapsed && Boolean(sessionCount) && (
            <span className="folder-session-count">{sessionCount}</span>
          )}
          {collapsed && workingCount > 0 && (
            <span
              className="folder-working"
              id={`${contentId}-working`}
              role="img"
              title={`${workingCount} ${workingCount === 1 ? 'session' : 'sessions'} working`}
              aria-label={`${workingCount} ${workingCount === 1 ? 'session' : 'sessions'} working`}
            />
          )}
        </button>
        {project && !project.isRepo && <span className="folder-chip faint">no git</span>}
        <span className="spacer" />
        {hostName && (
          <span className="folder-host" title={hostName}>
            {hostKey === LOCAL_HOST_KEY ? <Monitor size={11} /> : <Server size={11} />}
            <span className="folder-host-name">{hostName}</span>
          </span>
        )}
        <button
          className="icon-btn small"
          aria-label={projectless ? 'New session without a project' : `New session in ${name}`}
          onClick={startHere}
        >
          <Plus size={15} />
        </button>
      </div>
      <div id={contentId} hidden={collapsed}>
        {children ?? (
          <button className="folder-empty" onClick={startHere}>
            <Plus size={13} /> New session
          </button>
        )}
      </div>
    </section>
  )
}
