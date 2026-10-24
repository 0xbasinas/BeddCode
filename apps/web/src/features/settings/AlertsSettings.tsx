import { useCallback, useEffect, useState } from 'react'
import { BellRing, Smartphone } from 'lucide-react'
import { DEFAULT_ALERT_EVENTS, type AlertEvents, type RpcResult } from '@beddcode/contracts'
import { hostRequest, useRuntime } from '../../stores/host.ts'
import { timeAgo } from '../../ui/format.ts'
import { Toggle } from './PreferencesSettings.tsx'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const ALERT_EVENT_LABELS: { key: keyof AlertEvents; label: string; description: string }[] =
  [
    {
      key: 'needsYou',
      label: 'An agent needs you',
      description: 'An approval or a question is waiting',
    },
    {
      key: 'turnDone',
      label: 'A turn finishes',
      description: 'With the start of the agent’s reply',
    },
    { key: 'error', label: 'A turn fails', description: 'The agent stopped with an error' },
    { key: 'schedule', label: 'A scheduled run finishes', description: 'Done, failed, or skipped' },
  ]

type View = RpcResult<'alerts.settings'>

/**
 * Alerts the host sends by itself, so they reach a phone with every app closed: Expo push to the
 * paired phones that turned them on, and an optional ntfy topic.
 */
export function AlertsSettings({ hostKey }: { hostKey: string }) {
  const { connection, epoch } = useRuntime(hostKey)
  const online = connection === 'connected'
  const [view, setView] = useState<View>()
  const [ntfy, setNtfy] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!online) return
    try {
      const next = await hostRequest(hostKey, 'alerts.settings', {})
      setView(next)
      return next
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [hostKey, online])

  useEffect(() => {
    void load().then((v) => v && setNtfy(v.settings.ntfyUrl ?? ''))
  }, [load, epoch])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const events = view?.settings.ntfyEvents ?? DEFAULT_ALERT_EVENTS
  const saved = view?.settings.ntfyUrl ?? ''

  return (
    <>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-section-head">
        <h3>Phones</h3>
      </div>
      <div className="settings-card">
        {view?.devices.length === 0 && (
          <p className="settings-empty">
            No phone gets push alerts from this host yet. In the BeddCode app on your phone, open
            Settings and turn on alerts for this host.
          </p>
        )}
        {view?.devices.map((d) => (
          <div className="setting-row" key={`${d.deviceId ?? ''}:${d.tokenTail}`}>
            <Smartphone size={18} />
            <div className="setting-label">
              <span>{d.deviceName ?? 'Phone'}</span>
              <small>
                {ALERT_EVENT_LABELS.filter((e) => d.events[e.key])
                  .map((e) => e.label)
                  .join(' · ') || 'Nothing turned on'}{' '}
                · since {timeAgo(d.createdAt)} ago · …{d.tokenTail}
              </small>
            </div>
          </div>
        ))}
      </div>

      <div className="settings-section-head">
        <h3>ntfy</h3>
      </div>
      <div className="settings-card">
        <form
          className="setting-row"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() =>
              hostRequest(hostKey, 'alerts.setSettings', { ntfyUrl: ntfy.trim() || null }),
            )
          }}
        >
          <label className="setting-label" htmlFor="ntfy-url">
            <span>Topic address</span>
            <small>
              Works without push setup: subscribe to the same topic in the ntfy app. Anyone who
              knows a public topic can read it, so pick a long random name or your own server.
            </small>
          </label>
          <input
            id="ntfy-url"
            className="settings-input"
            placeholder="https://ntfy.sh/beddcode-…"
            value={ntfy}
            disabled={!online}
            onChange={(e) => setNtfy(e.target.value)}
          />
          <button className="settings-button" disabled={!online || busy || ntfy.trim() === saved}>
            Save
          </button>
        </form>
        {saved &&
          ALERT_EVENT_LABELS.map((e) => (
            <Toggle
              key={e.key}
              label={e.label}
              description={e.description}
              checked={events[e.key]}
              onChange={(value) =>
                void run(() =>
                  hostRequest(hostKey, 'alerts.setSettings', {
                    ntfyEvents: { ...events, [e.key]: value },
                  }),
                )
              }
            />
          ))}
      </div>

      <div className="settings-section-head">
        <h3>Recent alerts</h3>
        <div className="settings-actions">
          <button
            className="settings-button"
            disabled={!online || busy}
            onClick={() => void run(() => hostRequest(hostKey, 'alerts.test', {}))}
          >
            <BellRing size={14} /> Send a test
          </button>
        </div>
      </div>
      <div className="settings-card">
        {view?.recent.length === 0 && <p className="settings-empty">Nothing sent yet.</p>}
        {view?.recent.slice(0, 10).map((a, i) => (
          <div className="setting-row" key={`${a.at}-${i}`}>
            <div className="setting-label">
              <span>{a.title}</span>
              <small>{a.body}</small>
              <small>
                {timeAgo(a.at)} ago ·{' '}
                {a.deliveries.length === 0
                  ? 'Nowhere to send it'
                  : a.deliveries
                      .map((d) => `${d.to} ${d.ok ? '✓' : `✗ ${d.error ?? ''}`}`)
                      .join(' · ')}
              </small>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
