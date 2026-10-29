import { AgentMark } from '../../ui/AgentMark.tsx'
import { useEffect, useId, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Copy,
  FileDiff,
  FolderOpen,
  GitBranch,
  Layers,
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
import { usePane } from '../split/paneContext.ts'
import { useUiStore } from '../../stores/ui.ts'
import { folderName } from '../../ui/format.ts'
import { environmentHint } from './environment.ts'

/** The agent's name under the composer. The Environment bar is always there; nothing here hides it. */
/** Focuses the element `selector` names as soon as it exists (within ~10 frames), else `fallback`. */
function focusWhenReady(selector: string, fallback: HTMLElement | null, frames = 10) {
  const found = document.querySelector<HTMLElement>(selector)
  if (found) return found.focus()
  if (frames <= 0) return fallback?.focus()
  requestAnimationFrame(() => focusWhenReady(selector, fallback, frames - 1))
}

export function SessionChip({ agent }: { agent: string }) {
  return (
    <span className="chip-lite static" title="The agent running this session">
      <AgentMark agent={agent} label={agent} />
      {agent}
    </span>
  )
}

/**
 * Where this session runs and how: changes, host, branch, permission mode, terminal, folder, notes.
 * A small icon at the top right of the thread opens it as a card beneath it, over the thread. A
 * click elsewhere, Escape, its minimize button or the icon again closes it.
 */
export function EnvironmentButton({
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

  // Closed by default; the store keeps it open or closed while the app runs (not across restarts).
  // Beside other sessions, only the pane last used shows the card.
  const paneActive = usePane()?.active ?? true
  const open = useUiStore((s) => s.environmentOpen) && paneActive
  const setOpen = useUiStore((s) => s.setEnvironmentOpen)
  const anchor = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const cardId = useId()
  /** Closes the card; from the keyboard or its own button, focus goes back to the icon. */
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    // Focus moves into the card when it opens, unless it opened already focused somewhere inside.
    if (!cardRef.current?.contains(document.activeElement)) cardRef.current?.focus()
    const onPointer = (event: globalThis.PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) closeRef.current(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current(true)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const hint = environmentHint(connection === 'connected', stats)

  return (
    <div className="env-anchor" ref={anchor}>
      <button
        ref={trigger}
        className={`icon-btn env-trigger ${open ? 'open' : ''}`}
        aria-label="Environment"
        title="Environment"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        onClick={() => setOpen(!open)}
      >
        <Layers size={17} />
        {hint && <span className={`env-hint ${hint}`} aria-hidden="true" />}
      </button>
      {open && (
        <div
          ref={cardRef}
          id={cardId}
          className="env-card"
          role="dialog"
          aria-label="Session environment"
          tabIndex={-1}
        >
          <div className="session-panel-heading env-head">
            <span className="env-title">
              <Layers size={14} /> Environment
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
              <button className="icon-btn small" aria-label="Minimize" onClick={() => close(true)}>
                <Minus size={13} />
              </button>
            </span>
          </div>
          <div className="env-body">
            <button
              className="menu-row"
              onClick={() => {
                useUiStore.getState().showChanges()
                close(false)
                // Focus follows to the Changes tab once the pane has drawn it, else the icon.
                focusWhenReady(
                  '.side-pane .git-tabs [role="tab"][aria-selected="true"]',
                  trigger.current,
                )
              }}
            >
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
            <button className="menu-row" onClick={() => useUiStore.getState().openPane('terminal')}>
              <SquareTerminal size={16} />
              <span className="menu-text menu-title">Terminal</span>
            </button>
            <div className="session-panel-heading">
              {session.projectless ? 'Session files' : 'Repository'}
            </div>
            <button
              className="menu-row"
              title={session.cwd}
              onClick={() => useUiStore.getState().openPane('files')}
            >
              <FolderOpen size={16} />
              <span className="menu-text menu-title">
                {session.projectless ? 'Session files' : folderName(session.projectPath)}
              </span>
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
                {copied
                  ? 'Copied folder path'
                  : session.projectless
                    ? 'Copy session files path'
                    : 'Copy folder path'}
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
        </div>
      )}
    </div>
  )
}
