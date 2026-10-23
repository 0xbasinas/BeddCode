import { describe, expect, it } from 'vitest'
import type { SessionView } from '@beddcode/client-runtime'
import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
} from '../../stores/notificationPrefs.ts'
import { decide, inQuietHours, sessionAlerts, type Alert } from './logic.ts'

const at = (h: number, m = 0) => new Date(2026, 9, 22, h, m)
const quiet = (start: string, end: string, enabled = true) => ({ enabled, start, end })

describe('inQuietHours', () => {
  it('covers a window that runs past midnight', () => {
    const q = quiet('22:00', '08:00')
    expect(inQuietHours(q, at(23))).toBe(true)
    expect(inQuietHours(q, at(2, 30))).toBe(true)
    expect(inQuietHours(q, at(7, 59))).toBe(true)
    expect(inQuietHours(q, at(8))).toBe(false)
    expect(inQuietHours(q, at(12))).toBe(false)
    expect(inQuietHours(q, at(21, 59))).toBe(false)
  })

  it('covers a window within one day, and is off when disabled or empty', () => {
    expect(inQuietHours(quiet('13:00', '14:00'), at(13, 30))).toBe(true)
    expect(inQuietHours(quiet('13:00', '14:00'), at(14))).toBe(false)
    expect(inQuietHours(quiet('22:00', '08:00', false), at(23))).toBe(false)
    expect(inQuietHours(quiet('09:00', '09:00'), at(9))).toBe(false)
  })
})

const prefs = (patch: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...patch,
})
const alert = (kind: Alert['kind'], sessionId?: string): Alert => ({
  kind,
  title: 't',
  body: 'b',
  sessionId,
})
const away = { focused: false, now: at(12) }

describe('decide', () => {
  it('follows the switches for each kind of alert', () => {
    expect(decide(alert('turn-done', 's'), prefs({ turnDone: false }), away).show).toBe(false)
    expect(decide(alert('needs-you', 's'), prefs({ needsYou: false }), away).show).toBe(false)
    expect(decide(alert('host-disconnected'), prefs({ hostDisconnect: false }), away).show).toBe(
      false,
    )
    expect(decide(alert('turn-failed', 's'), prefs(), away).show).toBe(true)
  })

  it('stays quiet about the session you are looking at, unless asked to always alert', () => {
    const looking = { focused: true, viewing: 's', now: at(12) }
    expect(decide(alert('turn-done', 's'), prefs(), looking).show).toBe(false)
    expect(decide(alert('turn-done', 's'), prefs({ onlyInBackground: false }), looking).show).toBe(
      true,
    )
    // Another session, or a window that is not in front, still gets through.
    expect(decide(alert('turn-done', 'other'), prefs(), looking).show).toBe(true)
    expect(decide(alert('turn-done', 's'), prefs(), { ...looking, focused: false }).show).toBe(true)
    // A host alert is not about a session you could be looking at.
    expect(decide(alert('host-disconnected'), prefs(), looking).show).toBe(true)
  })

  it('holds everything but an agent waiting for you during quiet hours', () => {
    const p = prefs({ quietHours: quiet('22:00', '08:00') })
    const night = { focused: false, now: at(23) }
    expect(decide(alert('turn-done', 's'), p, night).show).toBe(false)
    expect(decide(alert('host-disconnected'), p, night).show).toBe(false)
    expect(decide(alert('needs-you', 's'), p, night).show).toBe(true)
  })

  it('plays a sound only when one is chosen', () => {
    expect(decide(alert('needs-you', 's'), prefs({ sound: 'chime' }), away)).toEqual({
      show: true,
      sound: true,
    })
    expect(decide(alert('needs-you', 's'), prefs({ sound: 'off' }), away)).toEqual({
      show: true,
      sound: false,
    })
  })
})

const session = (patch: Partial<SessionView>): SessionView =>
  ({
    id: 's1',
    title: 'Fix the limiter',
    status: 'idle',
    updatedAt: 1_000_000,
    items: [],
    ...patch,
  }) as SessionView
const now = 1_005_000

describe('sessionAlerts', () => {
  it('says when an agent is waiting, and on what', () => {
    const waiting = session({
      status: 'needs-you',
      items: [
        { kind: 'message', id: 'm', role: 'user', text: 'x' },
        {
          kind: 'approval',
          id: 'a',
          requestId: 'r',
          title: 'Run `rm -rf build`',
          options: [],
        },
      ],
    })
    expect(sessionAlerts('running', waiting, now)).toEqual([
      { kind: 'needs-you', title: 'Fix the limiter', body: 'Run `rm -rf build`', sessionId: 's1' },
    ])
  })

  it('says when a turn finished or failed, but only after running', () => {
    expect(sessionAlerts('running', session({ lastTurnReason: 'done' }), now)).toMatchObject([
      { kind: 'turn-done' },
    ])
    expect(sessionAlerts('running', session({ status: 'failed' }), now)).toMatchObject([
      { kind: 'turn-failed' },
    ])
    expect(sessionAlerts('running', session({ lastTurnReason: 'cancelled' }), now)).toEqual([])
    expect(sessionAlerts('idle', session({ lastTurnReason: 'done' }), now)).toEqual([])
  })

  it('ignores the first sight of a session, an unchanged status, and old news', () => {
    expect(sessionAlerts(undefined, session({ status: 'needs-you' }), now)).toEqual([])
    expect(sessionAlerts('needs-you', session({ status: 'needs-you' }), now)).toEqual([])
    expect(sessionAlerts('running', session({ lastTurnReason: 'done' }), now + 60_000)).toEqual([])
  })
})
