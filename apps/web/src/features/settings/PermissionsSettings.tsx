import { Shield } from 'lucide-react'
import { useRuntime } from '../../stores/host.ts'
import { agentDefaults, hostDefaults, usePreferences } from '../../stores/preferences.ts'
import { updateHostSettings, useHostSettings } from '../../stores/hostSettings.ts'
import { Select } from '../../ui/Select.tsx'

export function PermissionsSettings({ hostKey }: { hostKey: string }) {
  const { host, providers, connection } = useRuntime(hostKey)
  const hostId = host?.hostId ?? hostKey
  const defaults = usePreferences((s) => hostDefaults(s.hosts, hostId))
  const update = usePreferences((s) => s.setAgentDefaults)
  const autoReview = useHostSettings((s) => s.records[hostKey]?.settings.autoReview ?? 'off')
  return (
    <>
      <div className="settings-section-head">
        <h3>Approval mode</h3>
        <p>Saved on this host and shown on every connected app, including the phone.</p>
      </div>
      <div className="settings-card">
        <div className="setting-row">
          <Shield size={18} />
          <div className="setting-label">
            <span>When new work needs approval</span>
          </div>
          <Select
            id="auto-review"
            aria-label="Approval mode"
            disabled={connection !== 'connected'}
            value={autoReview}
            onChange={(e) =>
              void updateHostSettings(hostKey, {
                autoReview: e.target.value as 'off' | 'ask' | 'auto',
              }).catch(() => {})
            }
          >
            <option value="off">Off — use each agent’s own permission mode</option>
            <option value="ask">Ask — wait for approval</option>
            <option value="auto">Auto — approve routine work on its own</option>
          </Select>
        </div>
      </div>
      <div className="settings-section-head">
        <h3>Default permission modes</h3>
      </div>
      {providers
        .filter((p) => p.capabilities.permissionModes.length > 0)
        .map((provider) => {
          const saved = agentDefaults(defaults, provider)
          const mode = provider.capabilities.permissionModes.find(
            (m) => m.id === saved.permissionMode,
          )
          return (
            <div className="settings-card" key={provider.id}>
              <div className="setting-row">
                <Shield size={18} />
                <label className="setting-label" htmlFor={`permission-${provider.id}`}>
                  <span>{provider.label}</span>
                  {mode?.description && <small>{mode.description}</small>}
                </label>
                <Select
                  id={`permission-${provider.id}`}
                  aria-label={`${provider.label} permission mode`}
                  disabled={connection !== 'connected'}
                  value={saved.permissionMode ?? ''}
                  onChange={(e) =>
                    update(hostId, provider.id, { permissionMode: e.target.value || undefined })
                  }
                >
                  <option value="">Agent default</option>
                  {provider.capabilities.permissionModes.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
              {mode?.dangerous && (
                <p className="settings-notice">
                  This mode allows the agent to run commands and change files without asking.
                </p>
              )}
            </div>
          )
        })}
    </>
  )
}
