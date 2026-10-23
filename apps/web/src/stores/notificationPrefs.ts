import { create } from 'zustand'

export type NotificationSound = 'soft' | 'chime' | 'off'

export interface NotificationPrefs {
  /** An agent is waiting for you: a permission, a question, a plan to approve. */
  needsYou: boolean
  /** A turn ended and the agent waits for your next message. */
  turnDone: boolean
  /** A remote host stopped responding. */
  hostDisconnect: boolean
  sound: NotificationSound
  /** Skip alerts for the session you are looking at, while the app has focus. */
  onlyInBackground: boolean
  quietHours: { enabled: boolean; start: string; end: string }
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  needsYou: true,
  turnDone: true,
  hostDisconnect: true,
  sound: 'soft',
  onlyInBackground: true,
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
}

const KEY = 'beddcode.notification-prefs.v1'
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function parseNotificationPrefs(raw: string | null): NotificationPrefs {
  try {
    const saved: unknown = JSON.parse(raw ?? 'null')
    if (!saved || typeof saved !== 'object') return DEFAULT_NOTIFICATION_PREFS
    const v = saved as Record<string, unknown>
    const quiet = (v.quietHours ?? {}) as Record<string, unknown>
    const d = DEFAULT_NOTIFICATION_PREFS
    return {
      needsYou: v.needsYou !== false,
      turnDone: v.turnDone !== false,
      hostDisconnect: v.hostDisconnect !== false,
      sound: v.sound === 'chime' || v.sound === 'off' ? v.sound : 'soft',
      onlyInBackground: v.onlyInBackground !== false,
      quietHours: {
        enabled: quiet.enabled === true,
        start:
          typeof quiet.start === 'string' && TIME.test(quiet.start)
            ? quiet.start
            : d.quietHours.start,
        end: typeof quiet.end === 'string' && TIME.test(quiet.end) ? quiet.end : d.quietHours.end,
      },
    }
  } catch {
    return DEFAULT_NOTIFICATION_PREFS
  }
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export const useNotificationPrefs = create<{
  values: NotificationPrefs
  update(patch: Partial<NotificationPrefs>): void
}>((set) => ({
  values: parseNotificationPrefs(read()),
  update(patch) {
    set((state) => {
      const values = { ...state.values, ...patch }
      try {
        localStorage.setItem(KEY, JSON.stringify(values))
      } catch {
        // the choice still applies until the app closes
      }
      return { values }
    })
  },
}))
