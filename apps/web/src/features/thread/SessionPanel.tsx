import { useState } from 'react'
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
import { Dropdown } from '../../ui/Dropdown.tsx'
import { setMode, useRuntime } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { useUiStore } from '../../stores/ui.ts'
import { folderName } from '../../ui/format.ts'

export function SessionPanel({
  session,
  hostKey,
  agent,
  stats,
}: {
  session: SessionView
  hostKey: string
  agent: string
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
  const initials = agent
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <Dropdown
      panelClassName="session-panel"
      trigger={({ open, toggle }) => (
        <button
          className="chip-lite"
          aria-label="Session details"
          aria-expanded={open}
          onClick={toggle}
        >
          <span className="avatar">{initials}</span>
          {agent}
          <ChevronDown size={11} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="session-panel-heading">
            Environment
            <button
              className="icon-btn small"
              aria-label="Agent settings"
              onClick={() => {
                close()
                void navigate({ to: '/settings' })
              }}
            >
              <Settings size={13} />
            </button>
          </div>
          <button
            className="menu-row"
            onClick={() => {
              useUiStore.getState().openPane('git')
              close()
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
          <button
            className="menu-row"
            onClick={() => {
              useUiStore.getState().openPane('terminal')
              close()
            }}
          >
            <SquareTerminal size={16} />
            <span className="menu-text menu-title">Terminal</span>
          </button>
          <div className="session-panel-heading">Repository</div>
          <button
            className="menu-row"
            title={session.cwd}
            onClick={() => {
              useUiStore.getState().openPane('files')
              close()
            }}
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
        </>
      )}
    </Dropdown>
  )
}
