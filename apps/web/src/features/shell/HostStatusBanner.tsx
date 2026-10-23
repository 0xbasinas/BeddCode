import { useEffect, useState } from 'react'
import { useRuntime } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { desktopBridge, type DesktopDaemonState } from '../../ui/desktop.ts'
import { hostNotice } from './hostStatus.ts'

/**
 * In the desktop app, says what is happening when the local host is not reachable: starting,
 * starting again, or not staying up (with the last thing it said, a retry and its log).
 */
export function HostStatusBanner() {
  const daemon = desktopBridge()?.daemon
  const { connection } = useRuntime(LOCAL_HOST_KEY)
  const [state, setState] = useState<DesktopDaemonState | null>()
  const [busy, setBusy] = useState(false)
  // A brief gap while connecting is normal; only a lasting one is worth a banner.
  const [late, setLate] = useState(false)

  useEffect(() => {
    if (!daemon) return
    let live = true
    void daemon.status().then((s) => live && setState(s))
    const off = daemon.onStatus((s) => live && setState(s))
    return () => {
      live = false
      off()
    }
  }, [daemon])

  const notice = hostNotice(connection, state)
  useEffect(() => {
    if (!notice) return setLate(false)
    const timer = setTimeout(() => setLate(true), notice.tone === 'error' ? 0 : 900)
    return () => clearTimeout(timer)
  }, [notice?.text, notice?.tone])

  if (!daemon || !notice || !late) return null
  return (
    <div
      className={`host-banner ${notice.tone}`}
      role={notice.tone === 'error' ? 'alert' : 'status'}
    >
      <div>
        <strong>{notice.text}</strong>
        {notice.detail && <pre>{notice.detail}</pre>}
      </div>
      {notice.retry && (
        <div className="host-banner-actions">
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void daemon.restart().finally(() => setBusy(false))
            }}
          >
            Try again
          </button>
          <button onClick={() => void daemon.revealLog()}>Show log</button>
        </div>
      )}
    </div>
  )
}
