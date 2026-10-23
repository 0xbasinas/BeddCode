import type { SessionStatus, SessionView } from '@beddcode/client-runtime'
import type { NotificationPrefs } from '../../stores/notificationPrefs.ts'

export type AlertKind = 'needs-you' | 'turn-done' | 'turn-failed' | 'host-disconnected'

export interface Alert {
  kind: AlertKind
  title: string
  body: string
  /** The session to open when the alert is clicked, if it is about one. */
  sessionId?: string
}

/** Minutes since midnight of "HH:MM". */
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

/** True inside the quiet hours; the window may run past midnight (22:00 to 08:00). */
export function inQuietHours(prefs: NotificationPrefs['quietHours'], now: Date): boolean {
  if (!prefs.enabled) return false
  const at = now.getHours() * 60 + now.getMinutes()
  const start = minutes(prefs.start)
  const end = minutes(prefs.end)
  if (start === end) return false
  return start < end ? at >= start && at < end : at >= start || at < end
}

export interface Where {
  /** The app's window has focus. */
  focused: boolean
  /** The session open in the window, if any. */
  viewing?: string
  now: Date
}

export interface Decision {
  show: boolean
  sound: boolean
}

/**
 * Whether an alert should interrupt, by the user's choices. Quiet hours hold back everything
 * except an agent waiting for you; the sound follows the alert.
 */
export function decide(alert: Alert, prefs: NotificationPrefs, where: Where): Decision {
  const none = { show: false, sound: false }
  const wanted =
    alert.kind === 'needs-you'
      ? prefs.needsYou
      : alert.kind === 'host-disconnected'
        ? prefs.hostDisconnect
        : prefs.turnDone
  if (!wanted) return none
  if (alert.kind !== 'needs-you' && inQuietHours(prefs.quietHours, where.now)) return none
  // Looking right at the session: nothing to be told.
  if (
    prefs.onlyInBackground &&
    where.focused &&
    (alert.sessionId === undefined ? false : alert.sessionId === where.viewing)
  ) {
    return none
  }
  return { show: true, sound: prefs.sound !== 'off' }
}

/** What the agent is waiting on, in words, from the session's last transcript items. */
function waitingOn(session: SessionView): string {
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i]!
    if (item.kind === 'approval' && !item.resolvedOptionId && !item.cancelled) return item.title
    if (item.kind === 'question' && !item.answers && !item.dismissed)
      return 'Has a question for you'
  }
  return 'Waiting for you'
}

/**
 * The alerts a session's change deserves, given its status before and after. Recent changes only:
 * a replay after reconnecting brings old news that nobody should be told again.
 */
export function sessionAlerts(
  before: SessionStatus | undefined,
  session: SessionView,
  now: number,
): Alert[] {
  if (before === undefined || before === session.status) return []
  if (now - session.updatedAt > 20_000) return []
  const title = session.title || 'Session'
  if (session.status === 'needs-you') {
    return [{ kind: 'needs-you', title, body: waitingOn(session), sessionId: session.id }]
  }
  if (before === 'running' && session.status === 'idle' && session.lastTurnReason === 'done') {
    return [
      {
        kind: 'turn-done',
        title,
        body: 'Finished and waiting for your next message',
        sessionId: session.id,
      },
    ]
  }
  if (before === 'running' && (session.status === 'failed' || session.lastTurnReason === 'error')) {
    return [
      { kind: 'turn-failed', title, body: 'The turn stopped with an error', sessionId: session.id },
    ]
  }
  return []
}
