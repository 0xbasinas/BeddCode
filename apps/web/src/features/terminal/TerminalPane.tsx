import { paneProject } from '../shell/paneProject.ts'
import { Button } from '@/components/ui/button'
import { useCallback, useEffect, useRef, useState } from 'react'
import { applyTerminalChange, placeTerminal, shouldFollow, tabLabel } from './terminalTabs.ts'
import { Eye, Keyboard, Paperclip, Plus, SquareTerminal, Trash2, X } from 'lucide-react'
import type { PaneWorkspace } from '../../stores/composerWorkspace.ts'
import type { ProjectScript, TerminalInfo } from '@beddcode/contracts'
import { hostRequest, onHostFrame, useRuntime } from '../../stores/host.ts'
import { AgentIcon, agentKind } from '../../ui/AgentMark.tsx'
import { useHostKey } from '../../stores/HostScope.tsx'
import { TerminalView } from './TerminalView.tsx'
import { attachUpload } from '../composer/attachments.ts'
import { terminalContext } from './context.ts'
import { ProjectScripts } from './ProjectScripts.tsx'
import { samePath } from '../folders/folderLogic.ts'
import { confirmDialog } from '../../ui/confirm.tsx'

/** Terminals of the folder selected in the composer or open conversation. */
export function TerminalPane({ workspace }: { workspace: PaneWorkspace }) {
  const hostKey = useHostKey()
  return (
    <TerminalPaneContent key={JSON.stringify([hostKey, workspace.cwd])} workspace={workspace} />
  )
}

function TerminalPaneContent({ workspace }: { workspace: PaneWorkspace }) {
  const cwd = workspace.cwd
  const hostKey = useHostKey()
  const { epoch, projects, connection, host } = useRuntime(hostKey)
  const project = workspace.projectPath
    ? projects.find((p) => samePath(p.path, workspace.projectPath!))
    : undefined
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null)
  const terminalKey = `beddcode.active-terminal:${JSON.stringify([hostKey, cwd])}`
  const [active, setActive] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(terminalKey) ?? undefined
    } catch {
      return undefined
    }
  })
  const [recoveryNotice, setRecoveryNotice] = useState<string>()
  const previousEpoch = useRef(epoch)
  useEffect(() => {
    try {
      if (active) localStorage.setItem(terminalKey, active)
    } catch {
      /* Terminal still works for this window. */
    }
  }, [terminalKey, active])
  const [size, setSize] = useState<{ cols: number; rows: number }>()
  const [error, setError] = useState<string>()
  const [selection, setSelection] = useState({ terminalId: '', text: '' })
  const [renaming, setRenaming] = useState<string>()
  const closing = useRef(new Set<string>())

  const rename = async (id: string, name: string) => {
    setRenaming(undefined)
    const before = terminals?.find((t) => t.id === id)
    if (!before || name.trim() === tabLabel(before)) return
    try {
      const info = await hostRequest(hostKey, 'terminals.rename', {
        id,
        // Back to the default name also when the user typed exactly that.
        name: name.trim() === (before.title ?? before.shell) ? '' : name,
      })
      setTerminals((list) => applyTerminalChange(list ?? [], id, info))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    let cancelled = false
    hostRequest(hostKey, 'terminals.list', { cwd }).then(
      (list) => {
        if (cancelled) return
        setError(undefined)
        if (previousEpoch.current !== epoch) {
          setRecoveryNotice(
            (notice) =>
              notice ??
              'Reconnected. Available terminal history was reloaded; older output may no longer be retained by the host. Commands were not rerun.',
          )
          previousEpoch.current = epoch
        }
        setTerminals(list)
        const selected = activeRef.current
        if (selected && !list.some((t) => t.id === selected))
          setRecoveryNotice(
            'The previously selected terminal is no longer available on this host. Start a new terminal to continue.',
          )
        setActive((cur) => (cur && list.some((t) => t.id === cur) ? cur : list[0]?.id))
      },
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, cwd, epoch])

  // Agent terminals come and go on their own: the host says when one appears, runs or ends.
  const listRef = useRef(terminals)
  listRef.current = terminals
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(
    () =>
      onHostFrame(hostKey, (frame) => {
        if (frame.t !== 'term.changed' || !samePath(frame.cwd, cwd)) return
        const list = listRef.current ?? []
        const before = list.find((t) => t.id === frame.id)
        const shown = list.find((t) => t.id === activeRef.current)
        if (shouldFollow(before, frame.terminal, shown)) setActive(frame.id)
        setTerminals((cur) => (cur ? applyTerminalChange(cur, frame.id, frame.terminal) : cur))
        if (!frame.terminal && activeRef.current === frame.id) {
          setActive(list.filter((t) => t.id !== frame.id).at(-1)?.id)
        }
      }),
    [hostKey, cwd],
  )

  const takeOver = async (id: string) => {
    setError(undefined)
    try {
      const info = await hostRequest(hostKey, 'terminals.takeOver', { id })
      setTerminals((list) => applyTerminalChange(list ?? [], id, info))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const create = useCallback(
    async (script?: ProjectScript) => {
      setError(undefined)
      try {
        const info = await hostRequest(
          hostKey,
          'terminals.create',
          script
            ? { cwd, command: script.command, title: script.name, scriptId: script.id }
            : { cwd },
        )
        setTerminals((list) => placeTerminal(list ?? [], info))
        setActive(info.id)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [hostKey, cwd],
  )

  const close = async (id: string) => {
    if (closing.current.has(id)) return
    const terminal = listRef.current?.find((t) => t.id === id)
    if (!terminal) return
    closing.current.add(id)
    try {
      if (
        terminal.exited === undefined &&
        !(await confirmDialog(
          `Close ${tabLabel(terminal)}? This stops its process and clears its terminal history.`,
          'Close terminal',
        ))
      )
        return
      setError(undefined)
      await hostRequest(hostKey, 'terminals.close', { id })
      try {
        if (localStorage.getItem(terminalKey) === id) localStorage.removeItem(terminalKey)
      } catch {
        /* The terminal was closed even if browser storage is unavailable. */
      }
      setTerminals((list) => {
        const next = (list ?? []).filter((t) => t.id !== id)
        setActive((cur) => (cur === id ? next.at(-1)?.id : cur))
        return next
      })
    } catch (err) {
      setError(
        `Could not close ${tabLabel(terminal)}: ${err instanceof Error ? err.message : String(err)}. Try closing it again.`,
      )
    } finally {
      closing.current.delete(id)
    }
  }

  const current = terminals?.find((t) => t.id === active)
  const selectedText = selection.terminalId === current?.id ? selection.text : ''
  const shown = paneProject(workspace)
  const attachSelection = () => {
    if (!current || !selectedText.trim()) return
    void attachUpload(
      hostKey,
      workspace.draftId,
      new File(
        [
          terminalContext(
            { id: workspace.sessionId, title: workspace.title },
            current,
            selectedText,
          ),
        ],
        'terminal-selection.txt',
        {
          type: 'text/plain',
        },
      ),
    )
  }

  return (
    <div className="pane-body">
      <div className="pane-head">
        <h2>Terminal</h2>
        <span className="muted pane-project" title={shown.title}>
          {host?.name ?? hostKey} · {shown.label}
          {workspace.branch ? ` · ${workspace.branch}` : ''}
        </span>
        <span className="spacer" />
        <Button
          variant="app"
          className="icon-btn"
          aria-label="Attach terminal selection"
          title={
            selectedText.trim()
              ? 'Attach selected text to message'
              : 'Select terminal text to attach'
          }
          disabled={!selectedText.trim()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={attachSelection}
        >
          <Paperclip size={18} />
        </Button>
        <Button
          variant="app"
          className="icon-btn"
          aria-label="New terminal"
          onClick={() => void create()}
        >
          <Plus size={18} />
        </Button>
        <Button
          variant="app"
          className="icon-btn"
          aria-label="Close terminal"
          disabled={!current}
          onClick={() => current && void close(current.id)}
        >
          <Trash2 size={18} />
        </Button>
      </div>
      {connection !== 'connected' && (
        <div className="banner" role="status">
          Disconnected from host. Reconnecting will reattach to surviving terminals.
        </div>
      )}
      {recoveryNotice && (
        <div className="banner" role="status">
          <span className="banner-text">{recoveryNotice}</span>
          <Button
            variant="app"
            className="icon-btn"
            aria-label="Dismiss notice"
            title="Dismiss"
            onClick={() => {
              setRecoveryNotice(undefined)
              if (!active) {
                try {
                  localStorage.removeItem(terminalKey)
                } catch {
                  /* Optional persistence. */
                }
              }
            }}
          >
            <X size={14} />
          </Button>
        </div>
      )}
      {current && !current.agent && (
        <div className="muted term-agent-bar" role="status">
          {connection !== 'connected'
            ? 'Disconnected'
            : current.exited !== undefined
              ? `${current.scriptId ? 'Command' : 'Shell'} exited${current.exited === null ? '' : ` (${current.exited})`}`
              : `${current.scriptId ? 'Command' : 'Shell'} running`}
        </div>
      )}

      {project && (
        <ProjectScripts
          hostKey={hostKey}
          project={project}
          onRun={(script) => void create(script)}
        />
      )}
      {terminals === null && !error && <div className="git-empty muted">Loading…</div>}
      {error && <div className="composer-error pane-error">{error}</div>}

      {terminals?.length === 0 && (
        <div className="pane-empty">
          <span className="empty-icon">
            <SquareTerminal size={24} />
          </span>
          <h3>No terminal yet</h3>
          <p>Start a shell in {shown.label} to run commands.</p>
          <Button variant="app" className="primary-btn" onClick={() => void create()}>
            New terminal
          </Button>
        </div>
      )}

      {terminals && terminals.length > 0 && (
        <>
          <div className="term-tabs" role="tablist">
            {terminals.map((t) => (
              <div
                key={t.id}
                className={`term-tab${t.agent ? ' agent' : ''}`}
                aria-selected={t.id === active}
                role="tab"
                onDoubleClick={() => setRenaming(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setRenaming(t.id)
                }}
              >
                {renaming === t.id ? (
                  <input
                    className="term-tab-name"
                    aria-label="Terminal name"
                    autoFocus
                    maxLength={40}
                    defaultValue={tabLabel(t)}
                    placeholder={t.title ?? t.shell}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename(t.id, e.currentTarget.value)
                      else if (e.key === 'Escape') setRenaming(undefined)
                    }}
                    onBlur={(e) => void rename(t.id, e.currentTarget.value)}
                  />
                ) : (
                  <button
                    onClick={() => setActive(t.id)}
                    onKeyDown={(e) => e.key === 'F2' && setRenaming(t.id)}
                    title={
                      t.agent?.running
                        ? `Running: ${t.agent.running}`
                        : `${tabLabel(t)} (double-click to rename)`
                    }
                  >
                    {t.agent ? (
                      <span className="term-tab-agent">
                        <AgentIcon agent={t.agent.instanceId} label={t.agent.label} size={14} />
                        {!agentKind(t.agent.instanceId, t.agent.label) && (
                          <SquareTerminal size={14} />
                        )}
                      </span>
                    ) : (
                      <SquareTerminal size={14} />
                    )}{' '}
                    {tabLabel(t)}
                    {t.agent?.running && (
                      <span className="term-running" aria-label={`Running: ${t.agent.running}`} />
                    )}
                    {t.exited !== undefined && <span className="muted"> (exited)</span>}
                  </button>
                )}
                <button aria-label={`Close ${tabLabel(t)}`} onClick={() => void close(t.id)}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          {current && (
            <>
              {current.agent && (
                <div className="term-agent-bar">
                  <span className="term-agent-state">
                    {current.agent.running ? (
                      <>
                        <span className="term-running" aria-hidden />
                        <span className="muted">Running</span>{' '}
                        <code title={current.agent.running}>{current.agent.running}</code>
                      </>
                    ) : current.exited !== undefined ? (
                      <span className="muted">Session ended</span>
                    ) : (
                      <span className="muted">
                        Waiting for {current.agent.label}’s next command
                      </span>
                    )}
                  </span>
                  <span className="spacer" />
                  {current.agent.mode === 'mirror' ? (
                    <span
                      className="muted term-agent-typing"
                      title={`${current.agent.label} runs its commands itself; they are shown here as they run`}
                    >
                      <Eye size={14} /> Watching
                    </span>
                  ) : current.readOnly && current.exited === undefined ? (
                    <Button
                      variant="app"
                      className="secondary-btn term-take-over"
                      title="Type into the command the agent is running (for a prompt it waits on)"
                      onClick={() => void takeOver(current.id)}
                    >
                      <Keyboard size={14} /> Take over
                    </Button>
                  ) : current.exited === undefined ? (
                    <span className="muted term-agent-typing">
                      <Keyboard size={14} />{' '}
                      {current.agent.running ? 'Typing goes to the command' : 'Taken over'}
                    </span>
                  ) : null}
                </div>
              )}
              <TerminalView
                key={current.id}
                id={current.id}
                cwd={current.cwd}
                readOnly={Boolean(current.readOnly) || current.exited !== undefined}
                onSize={setSize}
                onSelection={(text) => setSelection({ terminalId: current.id, text })}
              />
              <div className="pane-foot">
                <span title={current.cwd}>
                  {current.agent ? (
                    <>
                      <Eye size={12} />{' '}
                      {current.agent.mode === 'pty'
                        ? `${current.agent.label}’s commands run here`
                        : `Mirrored from ${current.agent.label}`}
                      {current.readOnly ? ' · read-only' : ''} · {current.cwd}
                    </>
                  ) : (
                    <>
                      {current.shell} · {current.cwd}
                    </>
                  )}
                </span>
                <span>UTF-8{size ? ` · ${size.cols}×${size.rows}` : ''}</span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
