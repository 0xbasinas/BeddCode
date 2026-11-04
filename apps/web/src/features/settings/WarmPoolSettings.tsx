import { useCallback, useEffect, useState } from 'react'
import type { WarmPoolChange, WarmPoolSettings as Settings } from '@beddcode/contracts'
import { WARM_POOL_LIMITS } from '@beddcode/contracts'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { hostRequest, useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { HostNote, useHostMounted } from '../hosts/HostControls.tsx'
import { changeFromDraft, draftFromSettings, type WarmPoolDraft } from './warmPoolForm.ts'

const NUMBER_FIELDS = [
  {
    key: 'size',
    label: 'Pool size',
    help: 'Idle agents kept ready per agent and project. 0 keeps none.',
    unit: 'agents',
  },
  {
    key: 'memoryCapMb',
    label: 'Memory cap',
    help: 'Total memory all idle agents may use together.',
    unit: 'MB',
  },
  {
    key: 'idleTimeoutMinutes',
    label: 'Idle timeout',
    help: 'An agent nobody picked up is closed after this long.',
    unit: 'minutes',
  },
] as const

/** Keeps agents started ahead of time so a new session opens faster. Changes apply at once. */
export function WarmPoolSettings() {
  const local = useHostStore((s) => s.runtimes[LOCAL_HOST_KEY])
  const connected = local?.connection === 'connected'
  const [settings, setSettings] = useState<Settings>()
  const [draft, setDraft] = useState<WarmPoolDraft>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [unsupported, setUnsupported] = useState(false)
  const alive = useHostMounted()

  const load = useCallback(async () => {
    try {
      const next = await hostRequest(LOCAL_HOST_KEY, 'host.warmPool.get', {})
      if (!alive.current) return
      setSettings(next)
      setDraft(draftFromSettings(next))
    } catch {
      if (alive.current) setUnsupported(true)
    }
  }, [alive])
  useEffect(() => {
    if (connected) void load()
  }, [connected, load, local?.epoch])

  const save = async (change: WarmPoolChange) => {
    setBusy(true)
    setError(undefined)
    try {
      const next = await hostRequest(LOCAL_HOST_KEY, 'host.warmPool.set', change)
      if (!alive.current) return
      setSettings(next)
      setDraft(draftFromSettings(next))
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const apply = () => {
    if (!settings || !draft) return
    const result = changeFromDraft(draft, settings)
    if ('error' in result) return setError(result.error)
    if (Object.keys(result.change).length === 0) return setError(undefined)
    void save(result.change)
  }

  if (!connected || unsupported) {
    return (
      <p className="settings-inline-note">
        {unsupported
          ? 'This host does not support a warm pool.'
          : 'Connect to this PC to change the warm pool.'}
      </p>
    )
  }
  if (!settings || !draft) return null
  const pending = changeFromDraft(draft, settings)
  const dirty = 'error' in pending || Object.keys(pending.change).length > 0
  return (
    <>
      <div className="settings-card">
        <div className="setting-row">
          <div className="setting-label">
            <span>Keep agents ready</span>
            <small>
              Start Codex in the background for your projects, so a new session skips the wait. It
              uses memory while idle. Off by default.
            </small>
          </div>
          <Switch
            aria-label="Keep agents ready"
            checked={settings.enabled}
            disabled={busy}
            onCheckedChange={(enabled) => void save({ enabled })}
          />
        </div>
        {NUMBER_FIELDS.map(({ key, label, help, unit }) => (
          <div className="setting-row" key={key}>
            <div className="setting-label">
              <span>{label}</span>
              <small>{help}</small>
            </div>
            <Input
              type="number"
              className="warm-pool-input"
              min={WARM_POOL_LIMITS[key].min}
              max={WARM_POOL_LIMITS[key].max}
              step={1}
              value={draft[key]}
              disabled={busy}
              aria-label={`${label} (${unit})`}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
            />
            <span className="settings-value">{unit}</span>
          </div>
        ))}
      </div>
      <div className="settings-actions">
        <button
          type="button"
          className="settings-button primary"
          disabled={busy || !dirty}
          onClick={apply}
        >
          Apply
        </button>
        <button
          type="button"
          className="settings-button"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(draftFromSettings(settings))
            setError(undefined)
          }}
        >
          Reset
        </button>
      </div>
      {error && <HostNote tone="error">{error}</HostNote>}
    </>
  )
}
