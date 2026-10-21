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
import { clampOffset, loadOffset, saveOffset, type Offset } from './floating.ts'

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

  // Position: kept inside the thread however the window changes.
  const card = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState<Offset>(() => loadOffset(storage()))
  const drag = useRef<{ startX: number; startY: number; from: Offset } | null>(null)
  /** The latest position, which is what a drag starts from and what gets saved when it ends. */
  const latest = useRef(offset)

  const fit = (next: Offset): Offset => {
    const parent = card.current?.offsetParent
    if (!(parent instanceof HTMLElement) || !card.current) return next
    return clampOffset(
      next,
      { width: parent.clientWidth, height: parent.clientHeight },
      { width: card.current.offsetWidth, height: card.current.offsetHeight },
    )
  }
  useEffect(() => {
    const refit = () =>
      setOffset((current) => {
        latest.current = fit(current)
        return latest.current
      })
    refit()
    window.addEventListener('resize', refit)
    const observer = new ResizeObserver(refit)
    if (card.current) observer.observe(card.current)
    if (card.current?.offsetParent) observer.observe(card.current.offsetParent)
    return () => {
      window.removeEventListener('resize', refit)
      observer.disconnect()
    }
  }, [])

  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('button')) return
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
    // Dragging right shrinks the distance from the right edge.
    const next = fit({
      right: d.from.right - (e.clientX - d.startX),
      top: d.from.top + (e.clientY - d.startY),
    })
    latest.current = next
    setOffset(next)
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // Already released.
    }
    saveOffset(storage(), latest.current)
  }

  return (
    <div
      ref={card}
      className={`env-card ${minimized ? 'minimized' : ''}`}
      role="dialog"
      aria-label="Session environment"
      style={{ right: offset.right, top: offset.top }}
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
            aria-label={minimized ? 'Expand' : 'Minimize'}
            aria-expanded={!minimized}
            onClick={() => setMinimized(!minimized)}
          >
            {minimized ? <ChevronDown size={13} /> : <Minus size={13} />}
          </button>
        </span>
      </div>
      {minimized ? (
        <div className="env-summary" title="Expand to see the details">
          <GitBranch size={13} /> {session.branch ?? folderName(session.projectPath)}
          <span className="stat">
            <span className="add">+{stats.added}</span>{' '}
            <span className="del">−{stats.removed}</span>
          </span>
        </div>
      ) : (
        <div className="env-body">
          <button className="menu-row" onClick={() => useUiStore.getState().openPane('git')}>
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
