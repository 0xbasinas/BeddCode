import { useEffect, useState } from 'react'
import { reconnectHostsNow, useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'

/** A gap shorter than this is a normal blip, not worth a banner. */
const SHOW_AFTER_MS = 2_500

/**
 * Says so when a paired remote host cannot be reached, and that what you send meanwhile goes out
 * when it is back. Sessions on it keep their history; only live updates pause.
 */
export function RemoteStatusBanner() {
  const down = useHostStore((s) =>
    s.entries
      .filter((e) => e.key !== LOCAL_HOST_KEY)
      .filter((e) => {
        const c = s.runtimes[e.key]?.connection
        return c === 'reconnecting' || c === 'connecting'
      })
      .map((e) => s.runtimes[e.key]?.host?.name ?? e.name)
      .join('|'),
  )
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!down) return setLate(false)
    const timer = setTimeout(() => setLate(true), SHOW_AFTER_MS)
    return () => clearTimeout(timer)
  }, [down])

  if (!down || !late) return null
  const names = down.split('|')
  return (
    <div className="host-banner" role="status">
      <div>
        <strong>
          {names.length === 1 ? `Reconnecting to ${names[0]}…` : `Reconnecting to ${names.length} hosts…`}
        </strong>
        <div className="host-banner-detail">
          Messages you send now go out as soon as the connection is back.
        </div>
      </div>
      <div className="host-banner-actions">
        <button onClick={() => reconnectHostsNow()}>Retry now</button>
      </div>
    </div>
  )
}
