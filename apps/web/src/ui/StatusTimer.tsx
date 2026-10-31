import { useEffect, useState } from 'react'
import { elapsedLabel, type SessionView } from '@beddcode/client-runtime'
import { useAppPreferences } from '../stores/appPreferences.ts'

/** The wording for how long a session has been in its current state, or null when it has no timer. */
export function statusTimerLabel(s: SessionView, now: number): string | null {
  if (s.status === 'running')
    return `Running ${elapsedLabel(now - (s.turnStartedAt ?? s.statusSince))}`
  if (s.status === 'needs-you') return `Waiting on you ${elapsedLabel(now - s.statusSince)}`
  if (s.lastTurnMs !== undefined) {
    const since = new Date(s.statusSince).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
    return `Last turn ${elapsedLabel(s.lastTurnMs)} · idle since ${since}`
  }
  return null
}

/** Ticks every second while the session is running or waiting; stays still otherwise. */
export function StatusTimer({ session, className }: { session: SessionView; className?: string }) {
  const live = session.status === 'running' || session.status === 'needs-you'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  const slowMs = useAppPreferences((p) => p.values.slowTurnMinutes) * 60_000
  const label = statusTimerLabel(session, now)
  const slow =
    session.status === 'running' &&
    slowMs > 0 &&
    now - (session.turnStartedAt ?? session.statusSince) >= slowMs
  return label ? (
    <span className={slow ? `${className ?? ''} timer-slow` : className}>{label}</span>
  ) : null
}
