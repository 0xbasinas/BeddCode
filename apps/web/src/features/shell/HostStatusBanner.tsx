import { useEffect, useState } from 'react'
import { reconnectHostNow, useRuntime } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { desktopBridge, type DesktopDaemonState } from '../../ui/desktop.ts'
import { HOST_LOST_AFTER_MS, hostNotice } from './hostStatus.ts'

/**
 * Says what is happening when the local host is not reachable: in the desktop app starting,
 * starting again, or not staying up (with the last thing it said, a retry and its log); anywhere,
 * reconnecting, unreachable for a while, or a version the app cannot talk to.
 */
export function HostStatusBanner() {
  const daemon = desktopBridge()?.daemon
  const { connection } = useRuntime(LOCAL_HOST_KEY)
  const [state, setState] = useState<DesktopDaemonState | null>()
  const [busy, setBusy] = useState(false)
  // A brief gap while connecting is normal; only a lasting one is worth a banner.
  const [late, setLate] = useState(false)
  // When the link went down, to tell a blip from a host that is gone.
  const [downSince, setDownSince] = useState<number | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (connection === 'connected') return setDownSince(null)
    setDownSince((since) => since ?? Date.now())
  }, [connection])
  useEffect(() => {
    if (downSince === null) return
    const timer = setTimeout(
      () => setTick((n) => n + 1),
      Math.max(0, downSince + HOST_LOST_AFTER_MS - Date.now()) + 50,
    )
    return () => clearTimeout(timer)
  }, [downSince])

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

  const notice = hostNotice(connection, state, downSince === null ? 0 : Date.now() - downSince)
  useEffect(() => {
    if (!notice) return setLate(false)
    const timer = setTimeout(() => setLate(true), notice.tone === 'error' ? 0 : 900)
    return () => clearTimeout(timer)
  }, [notice?.text, notice?.tone])

  if (!notice || !late) return null
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
              if (daemon && state?.status === 'failed') {
                setBusy(true)
                void daemon.restart().finally(() => setBusy(false))
              } else reconnectHostNow(LOCAL_HOST_KEY)
            }}
          >
            Try again
          </button>
          {daemon && state?.status === 'failed' && (
            <button onClick={() => void daemon.revealLog()}>Show log</button>
          )}
        </div>
      )}
    </div>
  )
}
