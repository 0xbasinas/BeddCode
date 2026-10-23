import type { SessionStatus } from '@beddcode/client-runtime'
import { useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { useNotificationPrefs, type NotificationSound } from '../../stores/notificationPrefs.ts'
import { decide, sessionAlerts, type Alert } from './logic.ts'

/** How long a remote host may be unreachable before it is worth saying so. */
const DISCONNECT_GRACE_MS = 5_000

/** The session open in the window, read from the address (the app uses hash routing). */
function viewingSession(): string | undefined {
  try {
    return /^#\/session\/([^/?]+)/.exec(window.location.hash)?.[1]
  } catch {
    return undefined
  }
}

let audio: AudioContext | undefined

/** A short sound; no files, so nothing to load and nothing to ship. */
export function playSound(sound: NotificationSound) {
  if (sound === 'off' || typeof AudioContext === 'undefined') return
  try {
    audio ??= new AudioContext()
    const ctx = audio
    const tones = sound === 'chime' ? [660, 880] : [880]
    tones.forEach((hz, i) => {
      const start = ctx.currentTime + i * 0.11
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = hz
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + (sound === 'chime' ? 0.32 : 0.12))
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.4)
    })
  } catch {
    // no sound is better than an error
  }
}

/** Whether the system lets this app show notifications. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

/** Shows a system notification; clicking it brings the app forward and opens the session. */
export function showNotification(alert: Alert) {
  if (notificationPermission() !== 'granted') return
  try {
    const n = new Notification(alert.title, {
      body: alert.body,
      tag: alert.sessionId ?? alert.kind,
      icon: '/icon-192.png',
      silent: true, // the app plays its own sound, or none
    })
    n.onclick = () => {
      window.focus()
      if (alert.sessionId) window.location.hash = `#/session/${alert.sessionId}`
      n.close()
    }
  } catch {
    // some platforms refuse; the sound and the sidebar still tell the story
  }
}

/** Applies the user's choices to an alert, then shows it and plays its sound. */
export function deliver(alert: Alert, now = new Date()) {
  const decision = decide(alert, useNotificationPrefs.getState().values, {
    focused: typeof document !== 'undefined' && document.hasFocus(),
    viewing: viewingSession(),
    now,
  })
  if (!decision.show) return
  showNotification(alert)
  if (decision.sound) playSound(useNotificationPrefs.getState().values.sound)
}

/**
 * Watches every host's sessions and tells the user when an agent needs them, a turn ends, or a
 * remote host stops answering. Returns the function that stops watching.
 */
export function startNotifications(): () => void {
  const status = new Map<string, SessionStatus>()
  const link = new Map<string, string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const unsubscribe = useHostStore.subscribe((state) => {
    for (const [hostKey, runtime] of Object.entries(state.runtimes)) {
      // Until the first replay is done every session looks new; take stock without telling.
      if (runtime.synced) {
        for (const session of Object.values(runtime.replica.sessions)) {
          const key = `${hostKey}\u0000${session.id}`
          for (const alert of sessionAlerts(status.get(key), session, Date.now())) deliver(alert)
          status.set(key, session.status)
        }
      }

      if (hostKey === LOCAL_HOST_KEY) continue
      const before = link.get(hostKey)
      link.set(hostKey, runtime.connection)
      if (
        before === 'connected' &&
        runtime.connection !== 'connected' &&
        runtime.connection !== 'denied'
      ) {
        clearTimeout(timers.get(hostKey))
        timers.set(
          hostKey,
          setTimeout(() => {
            const now = useHostStore.getState().runtimes[hostKey]
            if (now?.connection === 'connected') return
            const name = now?.host?.name ?? state.entries.find((e) => e.key === hostKey)?.name
            deliver({
              kind: 'host-disconnected',
              title: `${name ?? 'A host'} stopped responding`,
              body: 'BeddCode is trying to reconnect.',
            })
          }, DISCONNECT_GRACE_MS),
        )
      } else if (runtime.connection === 'connected') {
        clearTimeout(timers.get(hostKey))
        timers.delete(hostKey)
      }
    }
  })
  return () => {
    unsubscribe()
    timers.forEach(clearTimeout)
  }
}
