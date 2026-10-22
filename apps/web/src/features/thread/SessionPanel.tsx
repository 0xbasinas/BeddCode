import { useEffect, useRef, useState, type PointerEvent } from 'react'
import {
  Check,
  ChevronDown,
  Copy,
  FileDiff,
  FolderOpen,
  GitBranch,
  GripHorizontal,
  Minus,
  Monitor,
  Settings,
  Shield,
  SquareTerminal,
} from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import type { SessionView } from '@beddcode/client-runtime'
import { setMode, useRuntime } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { useUiStore } from '../../stores/ui.ts'
import { folderName } from '../../ui/format.ts'
import {
  cardReserve,
  clampOffset,
  loadOffset,
  saveOffset,
  shouldDock,
  snapOffset,
  type Offset,
} from './floating.ts'

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** The agent's name under the composer. The Environment card is always there; nothing here hides it. */
export function SessionChip({ agent }: { agent: string }) {
  const initials = agent
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <span className="chip-lite static" title="The agent running this session">
      <span className="avatar">{initials}</span>
      {agent}
    </span>
  )
}

/**
 * Where this session runs and how: changes, host, branch, permission mode, terminal, folder, notes.
 * It floats over the transcript instead of covering it like a menu: drag it by its title to put it
 * where it is out of the way; it stays open while the conversation scrolls.
 */
export function EnvironmentCard({
  session,
  hostKey,
  stats,
}: {
  session: SessionView
  hostKey: string
  stats: { added: number; removed: number }
}) {
  const navigate = useNavigate()
  const minimized = useUiStore((s) => s.environmentMinimized)
  const setMinimized = useUiStore((s) => s.setEnvironmentMinimized)
  const { connection, host, providers } = useRuntime(hostKey)
  const provider = providers.find((p) => p.id === session.instanceId)
  const modes = session.modes ?? provider?.capabilities.permissionModes ?? []
  const mode = modes.find((m) => m.id === session.currentModeId) ?? modes[0]
  const [expanded, setExpanded] = useState<'host' | 'branch' | 'mode'>()
  const [error, setError] = useState<string>()
  const [changing, setChanging] = useState(false)
  const [copied, setCopied] = useState(false)
  const noteKey = `beddcode.session-notes:${hostKey}:${session.id}`
  const [notes, setNotes] = useState(() => {
    try {
      return localStorage.getItem(noteKey) ?? ''
    } catch {
      return ''
    }
  })
  const toggle = (row: typeof expanded) =>
    setExpanded((current) => (current === row ? undefined : row))

  // Position: kept inside the thread however the window changes, snapped to a side edge when
  // dropped, and docked above the conversation when the thread is too narrow to float beside it.
  const card = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState<Offset>(() => loadOffset(storage()))
  const drag = useRef<{ startX: number; startY: number; from: Offset } | null>(null)
  /** The latest position, which is what a drag starts from and what gets saved when it ends. */
  const latest = useRef(offset)
  const [docked, setDocked] = useState(false)
  /** Docked, the card starts minimized; this is the user opening it there (not remembered). */
  const [dockedOpen, setDockedOpen] = useState(false)
  const collapsed = docked ? !dockedOpen : minimized

  const sizes = () => {
    const el = card.current
    const parent = el?.offsetParent
    if (!el || !(parent instanceof HTMLElement)) return undefined
    return {
      parent,
      container: { width: parent.clientWidth, height: parent.clientHeight },
      card: { width: el.offsetWidth, height: el.offsetHeight },
    }
  }
  const fit = (next: Offset): Offset => {
    const s = sizes()
    return s ? clampOffset(next, s.container, s.card) : next
  }
  /**
   * Keeps the conversation out from under the card: the transcript (every message, tool row and
   * diff card in it) and, when the card reaches down to it, the composer get padding on the side
   * the card sits, as much as needed (often none on a wide window), through CSS variables. Runs on
   * every move of a drag, every size change of the card or the thread, and every resize.
   */
  const reserve = () => {
    const s = sizes()
    if (!s || !card.current) return
    const { parent } = s
    const scroller = parent.querySelector<HTMLElement>('.transcript')
    const inner = parent.querySelector<HTMLElement>('.transcript-inner')
    if (!scroller || !inner) return
    // The scroller's own padding, without the room this card already asked for.
    const asked = parseFloat(parent.style.getPropertyValue('--env-reserve-left')) || 0
    const padding = Math.max(0, (parseFloat(getComputedStyle(scroller).paddingLeft) || 0) - asked)
    const maxWidth = parseFloat(getComputedStyle(inner).maxWidth) || Number.POSITIVE_INFINITY
    const column = { padding, maxWidth }
    const dock = shouldDock(s.container.width, column)
    if (dock !== dockedRef.current) {
      dockedRef.current = dock
      setDocked(dock)
    }
    let room = { left: 0, right: 0 }
    let composer = { left: 0, right: 0 }
    if (!dock) {
      room = cardReserve(s.container.width, latest.current, s.card, column)
      const wrap = parent.querySelector<HTMLElement>('.composer-wrap')
      // The composer only moves aside when the card actually reaches down beside it.
      if (wrap && latest.current.top + s.card.height + 12 > wrap.offsetTop) composer = room
    }
    parent.style.setProperty('--env-reserve-left', `${room.left}px`)
    parent.style.setProperty('--env-reserve-right', `${room.right}px`)
    parent.style.setProperty('--env-composer-left', `${composer.left}px`)
    parent.style.setProperty('--env-composer-right', `${composer.right}px`)
    parent.classList.toggle('env-composer-aside', composer.left + composer.right > 0)
  }
  const dockedRef = useRef(docked)
  const reserveRef = useRef(reserve)
  reserveRef.current = reserve
  useEffect(() => {
    reserveRef.current()
  }, [offset, collapsed, docked])
  useEffect(() => {
    const parent = card.current?.offsetParent
    return () => {
      if (parent instanceof HTMLElement) {
        for (const name of [
          '--env-reserve-left',
          '--env-reserve-right',
          '--env-composer-left',
          '--env-composer-right',
        ]) {
          parent.style.removeProperty(name)
        }
        parent.classList.remove('env-composer-aside')
      }
    }
  }, [])

  useEffect(() => {
    const refit = () => {
      // Mid-drag the pointer handler owns the position; only the reserve follows the resize.
      if (!drag.current) {
        const next = fit(latest.current)
        if (next.right !== latest.current.right || next.top !== latest.current.top) {
          latest.current = next
          setOffset(next)
        }
      }
      reserveRef.current()
    }
    refit()
    window.addEventListener('resize', refit)
    const observer = new ResizeObserver(refit)
    const parent = card.current?.offsetParent
    if (card.current) observer.observe(card.current)
    if (parent) {
      observer.observe(parent)
      // The column's own box changes too (the side panes open and close, the composer grows).
      for (const el of parent.querySelectorAll('.transcript, .composer-wrap')) observer.observe(el)
    }
    return () => {
      window.removeEventListener('resize', refit)
      observer.disconnect()
    }
  }, [])

  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (docked || (e.target as Element).closest('button')) return
    try {
      // Keeps the drag going when the pointer leaves the title; not every input device allows it.
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Dragging still works while the pointer stays over the title.
    }
    drag.current = { startX: e.clientX, startY: e.clientY, from: latest.current }
  }
  const moveDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    // Dragging right shrinks the distance from the right edge. A card being dragged hugs no side.
    const next = fit({
      right: d.from.right - (e.clientX - d.startX),
      top: d.from.top + (e.clientY - d.startY),
    })
    latest.current = next
    setOffset(next)
    // The conversation follows the card live, not only once it is dropped.
    reserveRef.current()
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // Already released.
    }
    const s = sizes()
    const next = s ? snapOffset(latest.current, s.container, s.card) : latest.current
    latest.current = next
    setOffset(next)
    reserveRef.current()
    saveOffset(storage(), next)
  }

  return (
    <div
      ref={card}
      className={`env-card ${collapsed ? 'minimized' : ''} ${docked ? 'docked' : ''}`}
      role="dialog"
      aria-label="Session environment"
      data-side={docked ? 'docked' : (offset.side ?? 'right')}
      style={docked ? undefined : { right: offset.right, top: offset.top }}
    >
      <div
        className="session-panel-heading env-drag"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="env-title">
          <GripHorizontal size={14} /> Environment
        </span>
        <span className="env-actions">
          <button
            className="icon-btn small"
            aria-label="Agent settings"
            onClick={() => {
              void navigate({ to: '/settings' })
            }}
          >
            <Settings size={13} />
          </button>
          <button
            className="icon-btn small"
            aria-label={collapsed ? 'Expand' : 'Minimize'}
            aria-expanded={!collapsed}
            onClick={() => (docked ? setDockedOpen(!dockedOpen) : setMinimized(!minimized))}
          >
            {collapsed ? <ChevronDown size={13} /> : <Minus size={13} />}
          </button>
        </span>
      </div>
      {collapsed ? (
        <div className="env-summary" title="Expand to see the details">
          <GitBranch size={13} /> {session.branch ?? folderName(session.projectPath)}
          <span className="stat">
            <span className="add">+{stats.added}</span>{' '}
            <span className="del">−{stats.removed}</span>
          </span>
        </div>
      ) : (
        <div className="env-body">
          <button className="menu-row" onClick={() => useUiStore.getState().showChanges()}>
            <FileDiff size={16} />
            <span className="menu-text menu-title">Changes</span>
            <span className="stat">
              <span className="add">+{stats.added}</span>{' '}
              <span className="del">−{stats.removed}</span>
            </span>
          </button>
          <button
            className="menu-row"
            aria-expanded={expanded === 'host'}
            onClick={() => toggle('host')}
          >
            <Monitor size={16} />
            <span className="menu-text menu-title">
              {hostKey === LOCAL_HOST_KEY ? 'This PC' : (host?.name ?? 'Host')}
            </span>
            <span className={`dot ${connection === 'connected' ? 'ok' : 'warn'}`} />
            <ChevronDown size={12} />
          </button>
          {expanded === 'host' && (
            <div className="session-property">
              {host?.name}
              <br />
              {connection === 'connected' ? 'Connected' : 'Reconnecting…'} · {host?.platform}
            </div>
          )}
          <button
            className="menu-row"
            aria-expanded={expanded === 'branch'}
            onClick={() => toggle('branch')}
          >
            <GitBranch size={16} />
            <span className="menu-text menu-title">{session.branch ?? 'No branch'}</span>
            <ChevronDown size={12} />
          </button>
          {expanded === 'branch' && (
            <div className="session-property">
              {session.worktree ? `Worktree from ${session.worktree.baseBranch}` : 'Main checkout'}
              <br />
              {session.branch}
            </div>
          )}
          {mode && (
            <>
              <button
                className="menu-row"
                aria-expanded={expanded === 'mode'}
                onClick={() => toggle('mode')}
              >
                <Shield size={16} />
                <span className="menu-text menu-title">{mode.label}</span>
                <ChevronDown size={12} />
              </button>
              {expanded === 'mode' && (
                <div
                  className="session-panel-options"
                  role="group"
                  aria-label="Session permission mode"
                >
                  {modes.map((option) => (
                    <button
                      key={option.id}
                      className={option.dangerous ? 'danger' : ''}
                      disabled={connection !== 'connected' || changing}
                      aria-checked={mode.id === option.id}
                      role="menuitemradio"
                      onClick={() => {
                        setChanging(true)
                        setError(undefined)
                        void setMode(session.id, option.id)
                          .then(
                            () => setExpanded(undefined),
                            (err: unknown) =>
                              setError(err instanceof Error ? err.message : String(err)),
                          )
                          .finally(() => setChanging(false))
                      }}
                    >
                      {option.label}
                      <span className="spacer" />
                      {mode.id === option.id && <Check size={13} />}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <button className="menu-row" onClick={() => useUiStore.getState().openPane('terminal')}>
            <SquareTerminal size={16} />
            <span className="menu-text menu-title">Terminal</span>
          </button>
          <div className="session-panel-heading">Repository</div>
          <button
            className="menu-row"
            title={session.cwd}
            onClick={() => useUiStore.getState().openPane('files')}
          >
            <FolderOpen size={16} />
            <span className="menu-text menu-title">{folderName(session.projectPath)}</span>
          </button>
          <button
            className="menu-row"
            onClick={() => {
              void navigator.clipboard.writeText(session.cwd).then(
                () => setCopied(true),
                () => setError('Could not copy the folder path.'),
              )
            }}
          >
            <Copy size={16} />
            <span className="menu-text menu-title">
              {copied ? 'Copied folder path' : 'Copy folder path'}
            </span>
          </button>
          <div className="session-panel-heading">Notes</div>
          <div className="session-notes">
            <textarea
              aria-label="Session notes"
              placeholder="Notes for this session…"
              value={notes}
              onChange={(event) => {
                const value = event.target.value
                setNotes(value)
                try {
                  localStorage.setItem(noteKey, value)
                } catch {
                  setError('Notes could not be saved in this browser.')
                }
              }}
            />
          </div>
          {error && (
            <p className="composer-error menu-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
