import type { SessionView } from './replica.ts'

/** Whether a session is in the "waiting on you" state: it needs an answer, or the user marked it. */
export const isWaitingOnYou = (s: Pick<SessionView, 'status' | 'waitingMark'>): boolean =>
  s.status === 'needs-you' || s.waitingMark !== undefined

/** Whether the user's reminder for a marked session has come due. */
export const reminderDue = (s: Pick<SessionView, 'waitingMark'>, now = Date.now()): boolean =>
  s.waitingMark?.remindAt !== undefined && s.waitingMark.remindAt <= now

/** The next 10:00 in the morning after `now` (tomorrow at 10, as the reminder shortcut). */
export function tomorrowMorning(now = Date.now()): number {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(10, 0, 0, 0)
  return d.getTime()
}
