import { useState } from 'react'
import { useNotificationPrefs, type NotificationSound } from '../../stores/notificationPrefs.ts'
import { Select } from '../../ui/Select.tsx'
import { notificationPermission, playSound, showNotification } from '../notifications/notifier.ts'
import { Toggle } from './PreferencesSettings.tsx'

const SOUNDS: { id: NotificationSound; label: string }[] = [
  { id: 'soft', label: 'Soft tick' },
  { id: 'chime', label: 'Chime' },
  { id: 'off', label: 'None' },
]

/** Which agent events interrupt the user, and how. Everything else stays in the sidebar. */
export function NotificationsSettings() {
  const { values, update } = useNotificationPrefs()
  const [permission, setPermission] = useState(notificationPermission())

  const ask = async () => {
    if (typeof Notification === 'undefined') return
    setPermission(await Notification.requestPermission())
  }
  const setQuiet = (patch: Partial<typeof values.quietHours>) =>
    update({ quietHours: { ...values.quietHours, ...patch } })

  return (
    <>
      <header className="settings-heading">
        <h2>Notifications</h2>
        <p>Choose which agent events interrupt you. Everything else stays in the sidebar.</p>
      </header>

      {permission !== 'granted' && (
        <p className="settings-notice" role="status">
          {permission === 'unsupported'
            ? 'This browser cannot show desktop notifications. Sounds still play.'
            : permission === 'denied'
              ? 'Desktop notifications are blocked for this page. Allow them in the browser’s site settings.'
              : 'Desktop notifications need your permission first.'}{' '}
          {permission === 'default' && (
            <button className="settings-button" onClick={() => void ask()}>
              Allow notifications
            </button>
          )}
        </p>
      )}

      <div className="settings-section-head">
        <h3>Notify me when</h3>
      </div>
      <div className="settings-card">
        <Toggle
          label="An agent needs you"
          description="A permission, a question, or a plan waiting for your answer"
          checked={values.needsYou}
          onChange={(needsYou) => update({ needsYou })}
        />
        <Toggle
          label="A turn finishes"
          description="When an agent stops and waits for your next message"
          checked={values.turnDone}
          onChange={(turnDone) => update({ turnDone })}
        />
        <Toggle
          label="A host disconnects"
          description="When a remote machine stops responding"
          checked={values.hostDisconnect}
          onChange={(hostDisconnect) => update({ hostDisconnect })}
        />
      </div>

      <div className="settings-section-head">
        <h3>Delivery</h3>
      </div>
      <div className="settings-card">
        <div className="setting-row">
          <label className="setting-label" htmlFor="notify-sound">
            <span>Sound</span>
            <small>Played with each notification</small>
          </label>
          <Select
            id="notify-sound"
            value={values.sound}
            onChange={(e) => {
              const sound = e.target.value as NotificationSound
              update({ sound })
              playSound(sound)
            }}
          >
            {SOUNDS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>
        <Toggle
          label="Only when BeddCode is in the background"
          description="Skip alerts for the session you are looking at"
          checked={values.onlyInBackground}
          onChange={(onlyInBackground) => update({ onlyInBackground })}
        />
        <div className="setting-row">
          <div className="setting-label">
            <span>Quiet hours</span>
            <small>Mute everything except an agent that needs you</small>
          </div>
          <div className="quiet-hours">
            <input
              type="time"
              aria-label="Quiet hours start"
              value={values.quietHours.start}
              disabled={!values.quietHours.enabled}
              onChange={(e) => e.target.value && setQuiet({ start: e.target.value })}
            />
            <span>to</span>
            <input
              type="time"
              aria-label="Quiet hours end"
              value={values.quietHours.end}
              disabled={!values.quietHours.enabled}
              onChange={(e) => e.target.value && setQuiet({ end: e.target.value })}
            />
            <button
              className="settings-toggle"
              role="switch"
              aria-label="Quiet hours"
              aria-checked={values.quietHours.enabled}
              onClick={() => setQuiet({ enabled: !values.quietHours.enabled })}
            >
              <span />
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span>Try it</span>
            <small>Shows a notification the way an agent’s would appear</small>
          </div>
          <button
            className="settings-button"
            onClick={() => {
              showNotification({
                kind: 'needs-you',
                title: 'Notifications are on',
                body: 'This is how BeddCode will tell you an agent needs you.',
              })
              playSound(values.sound)
            }}
          >
            Send a test
          </button>
        </div>
      </div>
    </>
  )
}
