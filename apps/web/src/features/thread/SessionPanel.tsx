import { useEffect, useId, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Copy,
  FileDiff,
  FolderOpen,
  GitBranch,
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

/** The agent's name under the composer. The Environment bar is always there; nothing here hides it. */
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
 * Where this session runs and how, as one slim row of chips above the conversation: host, branch,
 * the changes (one click opens them in the Git pane), terminal and files. The chevron opens the
 * rest beneath it (host and worktree details, permission mode, folder, notes, settings) at the
 * bar's width; a click elsewhere or Escape closes it. It sits outside the transcript's scroller,
 * so it stays in view and never covers the conversation.
 */
export function EnvironmentBar({
  session,
  hostKey,
  stats,
}: {
  session: SessionView
  hostKey: string
  stats: { added: number; removed: number }
}) {
  const navigate = useNavigate()
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

  // The details open beneath the bar and close again on a click elsewhere or Escape.
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const detailsId = useId()
  useEffect(() => {
    if (!open) return
    const onPointer = (event: globalThis.PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const hostLabel = hostKey === LOCAL_HOST_KEY ? 'This PC' : (host?.name ?? 'Host')
  const connected = connection === 'connected'

  return (
    <div className="env-bar-wrap">
      <div className="env-column">
        <div className="env-anchor" ref={anchor}>
          <div className="env-bar" role="toolbar" aria-label="Session environment">
            <span
              className="env-chip"
              title={`${host?.name ?? hostLabel} · ${connected ? 'Connected' : 'Reconnecting…'}`}
            >
              <Monitor size={13} />
              <span className="env-chip-text">{hostLabel}</span>
              <span className={`dot ${connected ? 'ok' : 'warn'}`} />
            </span>
            <span
              className="env-chip"
              title={
                session.worktree
                  ? `Worktree from ${session.worktree.baseBranch}`
                  : `Main checkout of ${folderName(session.projectPath)}`
              }
            >
              <GitBranch size={13} />
              <span className="env-chip-text">
                {session.branch ?? folderName(session.projectPath)}
              </span>
            </span>
            <button
              className="env-chip action"
              title="Open the changes in the Git pane"
              onClick={() => useUiStore.getState().showChanges()}
            >
              <FileDiff size={13} />
              <span className="stat">
                <span className="add">+{stats.added}</span>{' '}
                <span className="del">−{stats.removed}</span>
              </span>
            </button>
            <span className="env-bar-sep" />
            <button
              className="icon-btn small"
              aria-label="Open the terminal"
              title="Terminal"
              onClick={() => useUiStore.getState().openPane('terminal')}
            >
              <SquareTerminal size={13} />
            </button>
            <button
              className="icon-btn small"
              aria-label="Open the files"
              title="Files"
              onClick={() => useUiStore.getState().openPane('files')}
            >
              <FolderOpen size={13} />
            </button>
            <button
              className={`icon-btn small env-toggle ${open ? 'open' : ''}`}
              aria-label={open ? 'Hide session details' : 'Show session details'}
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen(!open)}
            >
              <ChevronDown size={13} />
            </button>
          </div>
          {open && (
            <div className="env-details" id={detailsId} role="dialog" aria-label="Session details">
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
                  {session.worktree
                    ? `Worktree from ${session.worktree.baseBranch}`
                    : 'Main checkout'}
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
              <button
                className="menu-row"
                onClick={() => {
                  void navigate({ to: '/settings' })
                }}
              >
                <Settings size={16} />
                <span className="menu-text menu-title">Agent settings</span>
              </button>
              {error && (
                <p className="composer-error menu-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
