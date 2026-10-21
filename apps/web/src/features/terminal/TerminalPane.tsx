import { useCallback, useEffect, useState } from 'react'
import { Plus, SquareTerminal, Trash2, X } from 'lucide-react'
import type { SessionView } from '@beddcode/client-runtime'
import type { TerminalInfo } from '@beddcode/contracts'
import { hostRequest, useRuntime } from '../../stores/host.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import { TerminalView } from './TerminalView.tsx'

/** Terminals of the folder a session works in. */
export function TerminalPane({ session }: { session: SessionView }) {
  const cwd = session.cwd
  const hostKey = useHostKey()
  const { epoch } = useRuntime(hostKey)
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null)
  const [active, setActive] = useState<string>()
  const [size, setSize] = useState<{ cols: number; rows: number }>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    hostRequest(hostKey, 'terminals.list', { cwd }).then(
      (list) => {
        if (cancelled) return
        setTerminals(list)
        setActive((cur) => (cur && list.some((t) => t.id === cur) ? cur : list[0]?.id))
      },
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, cwd, epoch])

  const create = useCallback(async () => {
    setError(undefined)
    try {
      const info = await hostRequest(hostKey, 'terminals.create', { cwd })
      setTerminals((list) => [...(list ?? []), info])
      setActive(info.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [hostKey, cwd])

  const close = async (id: string) => {
    await hostRequest(hostKey, 'terminals.close', { id }).catch(() => {})
    setTerminals((list) => {
      const next = (list ?? []).filter((t) => t.id !== id)
      setActive((cur) => (cur === id ? next.at(-1)?.id : cur))
      return next
    })
  }

  const current = terminals?.find((t) => t.id === active)
  const folder = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd

  return (
    <div className="pane-body">
      <div className="pane-head">
        <h2>Terminal</h2>
        <span className="muted">{session.branch ?? folder}</span>
        <span className="spacer" />
        <button className="icon-btn" aria-label="New terminal" onClick={() => void create()}>
          <Plus size={18} />
        </button>
        <button
          className="icon-btn"
          aria-label="Close terminal"
          disabled={!current}
          onClick={() => current && void close(current.id)}
        >
          <Trash2 size={17} />
        </button>
      </div>

      {terminals === null && !error && <div className="git-empty muted">Loading…</div>}
      {error && <div className="composer-error pane-error">{error}</div>}

      {terminals?.length === 0 && (
        <div className="pane-empty">
          <span className="empty-icon">
            <SquareTerminal size={26} />
          </span>
          <h3>No terminal yet</h3>
          <p>Start a shell in this session&apos;s folder to run commands next to the agent.</p>
          <button className="primary-btn" onClick={() => void create()}>
            New terminal
          </button>
        </div>
      )}

      {terminals && terminals.length > 0 && (
        <>
          <div className="term-tabs" role="tablist">
            {terminals.map((t) => (
              <div key={t.id} className="term-tab" aria-selected={t.id === active} role="tab">
                <button onClick={() => setActive(t.id)}>
                  <SquareTerminal size={14} /> {t.shell}
                  {t.exited !== undefined && <span className="muted"> (exited)</span>}
                </button>
                <button aria-label={`Close ${t.shell}`} onClick={() => void close(t.id)}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          {current && (
            <>
              <TerminalView key={current.id} id={current.id} onSize={setSize} />
              <div className="pane-foot">
                <span title={current.cwd}>
                  {current.shell} · {current.cwd}
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
