import { useRef, useState } from 'react'
import { Hand, MonitorSmartphone, Play, Square } from 'lucide-react'
import { hostRequest, interrupt } from '../../stores/host.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import { usePolled } from '../git/usePolled.ts'
import './desktop.css'

interface Picture {
  data: string
  mime: string
}

/**
 * What the agent is doing on the computer: its latest window picture, the last actions, and the two
 * controls the user needs: Stop (ends the turn and takes back the session's access) and Take over
 * (the agent's computer calls wait until the user hands the controls back).
 */
export function DesktopPane({ sessionId, working }: { sessionId: string; working: boolean }) {
  const hostKey = useHostKey()
  const lastAt = useRef(0)
  const [picture, setPicture] = useState<Picture>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const view = usePolled(
    async () => {
      const v = await hostRequest(hostKey, 'computer.view', {
        sessionId,
        ...(lastAt.current ? { since: lastAt.current } : {}),
      })
      if (v.image) setPicture(v.image)
      lastAt.current = v.at
      return v
    },
    `${hostKey}:${sessionId}`,
    working ? 1000 : 3000,
  )
  const v = view.data

  const control = async (paused: boolean) => {
    setBusy(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'computer.control', { sessionId, paused })
      view.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await interrupt(sessionId)
      view.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (view.loading) return <div className="git-empty muted">Loading…</div>
  if (view.error) {
    return (
      <div className="git-empty">
        <div>The desktop view is unavailable</div>
        <div className="muted">{view.error}</div>
      </div>
    )
  }
  if (!v?.enabled) {
    return (
      <div className="git-empty">
        <MonitorSmartphone size={22} />
        <div>This session cannot use the computer</div>
        <div className="muted">Turn on “Use computer” when starting a session.</div>
      </div>
    )
  }

  const state = v.paused
    ? 'You have the controls'
    : v.active
      ? 'Agent is using the desktop'
      : 'Idle'
  return (
    <div className="desktop-pane">
      <div className="desktop-bar">
        <span className={`desktop-state ${v.paused ? 'paused' : v.active ? 'active' : ''}`}>
          {state}
        </span>
        <span className="desktop-spacer" />
        {v.paused ? (
          <button className="desktop-btn" disabled={busy} onClick={() => void control(false)}>
            <Play size={13} /> Hand back
          </button>
        ) : (
          <button className="desktop-btn" disabled={busy} onClick={() => void control(true)}>
            <Hand size={13} /> Take over
          </button>
        )}
        <button
          className="desktop-btn danger"
          disabled={busy || !working}
          title={working ? 'Stop the agent and take back its access' : 'The agent is not running'}
          onClick={() => void stop()}
        >
          <Square size={13} /> Stop
        </button>
      </div>
      {error && <div className="desktop-error">{error}</div>}
      <div className="desktop-shot">
        {picture ? (
          <img
            src={`data:${picture.mime};base64,${picture.data}`}
            alt={v.title ? `${v.app}: ${v.title}` : 'The window the agent last looked at'}
          />
        ) : (
          <div className="muted">The agent has not looked at a window yet.</div>
        )}
      </div>
      {v.app && (
        <div className="desktop-caption" title={v.title}>
          {v.app}
          {v.title ? ` · ${v.title}` : ''}
          {picture && <span className="muted"> · picture from the last time it looked</span>}
        </div>
      )}
      <div className="desktop-actions" aria-label="Recent actions">
        {v.actions.length === 0 ? (
          <div className="muted">No actions yet.</div>
        ) : (
          [...v.actions].reverse().map((a, i) => <div key={`${i}-${a}`}>{a}</div>)
        )}
      </div>
    </div>
  )
}
