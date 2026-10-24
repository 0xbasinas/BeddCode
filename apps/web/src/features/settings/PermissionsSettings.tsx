import { Shield } from 'lucide-react'
import { useRuntime } from '../../stores/host.ts'
import { agentDefaults, hostDefaults, usePreferences } from '../../stores/preferences.ts'
import { Select } from '../../ui/Select.tsx'

export function PermissionsSettings({ hostKey }: { hostKey: string }) {
  const { host, providers, connection } = useRuntime(hostKey)
  const hostId = host?.hostId ?? hostKey
  const defaults = usePreferences((s) => hostDefaults(s.hosts, hostId))
  const update = usePreferences((s) => s.setAgentDefaults)
  return (
    <>
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
