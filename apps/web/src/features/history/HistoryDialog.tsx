import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { History, X } from 'lucide-react'
import type { HistoryEntry } from '@beddcode/contracts'
import { Select } from '../../ui/Select.tsx'
import { folderName, timeAgo } from '../../ui/format.ts'
import { hostRequest, importSession, useRuntime } from '../../stores/host.ts'

/** Agents that keep a conversation history on their host and can pick one back up. */
export function agentsWithHistory<
  T extends { status: string; capabilities: { history?: boolean } },
>(providers: T[]): T[] {
  return providers.filter((p) => p.status === 'ready' && p.capabilities.history === true)
}

/**
 * Earlier conversations of an agent, including ones started in its own CLI. Picking one brings it
 * in as a session; the agent resumes it on the first message.
 */
export function HistoryDialog({
  hostKey,
  folder,
  instanceId: initialInstance,
  onClose,
}: {
  hostKey: string
  /** The folder to look in; the agent's whole history when empty. */
  folder?: string
  instanceId?: string
  onClose(): void
}) {
  const navigate = useNavigate()
  const { providers } = useRuntime(hostKey)
  const agents = agentsWithHistory(providers)
  const [instanceId, setInstanceId] = useState(
    agents.find((a) => a.id === initialInstance)?.id ?? agents[0]?.id,
  )
  const [scope, setScope] = useState<'folder' | 'all'>(folder ? 'folder' : 'all')
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [error, setError] = useState<string>()
  const [opening, setOpening] = useState<string>()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !opening && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, opening])

  useEffect(() => {
    if (!instanceId) return
    let cancelled = false
    setEntries(null)
    setError(undefined)
    hostRequest(hostKey, 'history.list', {
      instanceId,
      cwd: scope === 'folder' ? folder : undefined,
    }).then(
      (list) => !cancelled && setEntries(list),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, instanceId, scope, folder])

  const open = async (entry: HistoryEntry) => {
    if (!instanceId || opening) return
    setOpening(entry.id)
    setError(undefined)
    try {
      const sessionId = await importSession(hostKey, {
        instanceId,
        providerSessionId: entry.id,
        cwd: entry.cwd ?? folder,
      })
      onClose()
      void navigate({ to: '/session/$sessionId', params: { sessionId } })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setOpening(undefined)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !opening && onClose()}
    >
      <div className="modal" role="dialog" aria-label="Resume an earlier conversation">
        <header className="modal-head">
          <h2>Resume an earlier conversation</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={!!opening}>
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">
          {agents.length === 0 ? (
            <p className="muted">
              None of the agents on this host keep a history BeddCode can read.
            </p>
          ) : (
            <>
              <div className="history-filters">
                <Select
                  aria-label="Agent"
                  value={instanceId}
                  onChange={(e) => setInstanceId(e.target.value)}
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </Select>
                {folder && (
                  <Select
                    aria-label="Where"
                    value={scope}
                    onChange={(e) => setScope(e.target.value as 'folder' | 'all')}
                  >
                    <option value="folder">In {folderName(folder)}</option>
                    <option value="all">Everywhere</option>
                  </Select>
                )}
              </div>
              {entries === null && !error && <p className="muted">Looking…</p>}
              {error && (
                <p className="settings-error" role="alert">
                  {error}
                </p>
              )}
              {entries?.length === 0 && <p className="muted">No earlier conversations found.</p>}
              <ul className="history-list">
                {entries?.map((entry) => (
                  <li key={entry.id}>
                    <button
                      className="history-row"
                      disabled={!!opening}
                      onClick={() => void open(entry)}
                    >
                      <History size={15} />
                      <span className="history-main">
                        <span className="history-title">{entry.title}</span>
                        <span className="muted">
                          {entry.cwd ? folderName(entry.cwd) : ''}
                          {entry.updatedAt ? ` · ${timeAgo(entry.updatedAt)} ago` : ''}
                        </span>
                      </span>
                      <span className="muted">
                        {opening === entry.id
                          ? 'Opening…'
                          : entry.imported
                            ? 'Open again'
                            : 'Resume'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
