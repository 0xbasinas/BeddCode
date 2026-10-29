type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

export interface WakeClock {
  now(): number
  every(ms: number, tick: () => void): () => void
}

const realClock: WakeClock = {
  now: () => Date.now(),
  every(ms, tick) {
    const timer = setInterval(tick, ms)
    return () => clearInterval(timer)
  },
}

/** How often the page checks that its timers still run on time. */
const TICK_MS = 5_000
/** A tick this much later than due means the machine slept (or the clock jumped). */
const GAP_MS = 30_000

/**
 * Calls `onWake` when the page is likely to have just come back: the network returned, the tab or
 * window became visible again, or the machine woke from sleep while the page stayed visible (a
 * desktop window or a laptop lid: no event says so, but timers stop running while asleep, so a
 * tick that comes far too late gives it away). Returns the function that stops listening.
 */
export function onDeviceWake(
  onWake: () => void,
  win: Listenable & { navigator?: { onLine?: boolean } } = window,
  doc: Listenable & { visibilityState?: string } = document,
  clock: WakeClock = realClock,
): () => void {
  let last = clock.now()
  const stopTicking = clock.every(TICK_MS, () => {
    const at = clock.now()
    const late = at - last - TICK_MS
    last = at
    // A hidden tab's timers are throttled to once a minute by design; visibilitychange covers it.
    // A clock set backwards shows as a negative gap: also worth a check of the connection.
    if ((late > GAP_MS || late < -GAP_MS) && doc.visibilityState !== 'hidden') onWake()
  })
  const online = () => onWake()
  const visible = () => {
    if (doc.visibilityState === 'visible') onWake()
  }
  win.addEventListener('online', online)
  win.addEventListener('focus', visible)
  doc.addEventListener('visibilitychange', visible)
  return () => {
    stopTicking()
    win.removeEventListener('online', online)
    win.removeEventListener('focus', visible)
    doc.removeEventListener('visibilitychange', visible)
  }
}
