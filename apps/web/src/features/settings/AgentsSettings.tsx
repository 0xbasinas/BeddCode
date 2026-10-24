import { useEffect, useState } from 'react'
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { AcpAgentSummary, AgentPreview, ProviderInstance } from '@beddcode/contracts'
import { hostRequest, refreshProviders, useRuntime } from '../../stores/host.ts'
import { agentDefaults, hostDefaults, usePreferences } from '../../stores/preferences.ts'
import { AddAgentDialog } from './AddAgentDialog.tsx'
import { modelChoice, modelEfforts } from '../../ui/models.ts'
import { Select } from '../../ui/Select.tsx'

const STATUS: Record<ProviderInstance['status'], string> = {
  ready: 'Ready',
  'needs-sign-in': 'Needs sign-in',
  'not-installed': 'Not installed',
  error: 'Unavailable',
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
const initials = (label: string) =>
  label
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

export function AgentsSettings({ hostKey }: { hostKey: string }) {
  const { host, providers, connection, epoch } = useRuntime(hostKey)
  const hostId = host?.hostId ?? hostKey
  const defaults = usePreferences((s) => hostDefaults(s.hosts, hostId))
  const setDefaultAgent = usePreferences((s) => s.setDefaultAgent)
  const setAgentDefaults = usePreferences((s) => s.setAgentDefaults)
  const [agents, setAgents] = useState<AcpAgentSummary[]>([])
  const [selected, setSelected] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [removeId, setRemoveId] = useState<string>()
  const online = connection === 'connected'
  // ACP agents only say what they offer (including how much they ask) when a session starts, so
  // the host starts one briefly to find out; the answer is remembered there.
  const [offered, setOffered] = useState<{ id: string; data?: AgentPreview; failed?: boolean }>()
  const acpId = providers.find(
    (p) => p.id === (selected ?? defaults.instanceId ?? providers[0]?.id),
  )
  const previewId = acpId?.kind === 'acp' ? acpId.id : undefined
  useEffect(() => {
    if (!online || !previewId) return
    let cancelled = false
    setOffered({ id: previewId })
    hostRequest(hostKey, 'agents.preview', { instanceId: previewId, cwd: host?.defaultCwd }).then(
      (data) => !cancelled && setOffered({ id: previewId, data }),
      () => !cancelled && setOffered({ id: previewId, failed: true }),
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, online, previewId, epoch, host?.defaultCwd])
  const current =
    providers.find((p) => p.id === selected) ??
    providers.find((p) => p.id === defaults.instanceId) ??
    providers[0]
  const saved = agentDefaults(defaults, current)
  const agentOffer = current && offered?.id === current.id ? offered : undefined
  const permissionModes = current
    ? current.capabilities.permissionModes.length > 0
      ? current.capabilities.permissionModes
      : (agentOffer?.data?.modes ?? [])
    : []
  const efforts = current
    ? modelEfforts(
        current.capabilities.models ?? [],
        current.capabilities.efforts ?? [],
        saved.model,
      )
    : []

  useEffect(() => {
    if (!online) return
    let cancelled = false
    hostRequest(hostKey, 'agents.list', {}).then(
      (list) => {
        if (!cancelled) setAgents(list)
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err))
      },
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, online, epoch])

  const refresh = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const [, list] = await Promise.all([
        refreshProviders(hostKey),
        hostRequest(hostKey, 'agents.list', {}),
      ])
      setAgents(list)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!removeId) return
    setBusy(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'agents.remove', { id: removeId })
      setRemoveId(undefined)
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {!online && (
        <p className="settings-notice" role="status">
          This host is offline. Reconnect to manage its agents.
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-section-head">
        <h3>Installed agents</h3>
        <div className="settings-actions">
          <button
            className="settings-button"
            disabled={!online || busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} />
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            className="settings-button"
            disabled={!online || busy}
            onClick={() => setAdding(true)}
          >
            <Plus size={14} /> Add agent
          </button>
        </div>
      </div>
      <div className="settings-card agent-list">
        {providers.length === 0 && (
          <p className="settings-empty">
            {online ? 'Detecting agents on this host…' : 'No agent information available.'}
          </p>
        )}
        {providers.map((provider) => {
          const configured = agents.find((a) => provider.id === `acp:${a.id}`)
          return (
            <div
              key={provider.id}
              className={`agent-row ${current?.id === provider.id ? 'selected' : ''}`}
            >
              <button
                className="agent-select"
                aria-pressed={current?.id === provider.id}
                onClick={() => {
                  setSelected(provider.id)
                }}
              >
                <span className="agent-avatar">{initials(provider.label)}</span>
                <span className="setting-label">
                  <span>
                    {provider.label}
                    {defaults.instanceId === provider.id && (
                      <span className="settings-badge">Default</span>
                    )}
                  </span>
                  <small>
                    {provider.version ? `${provider.version} · ` : ''}
                    {configured
                      ? 'ACP agent'
                      : provider.kind === 'fake'
                        ? 'Scripted test agent'
                        : 'Native agent'}
                  </small>
                </span>
                <span className="agent-status">
                  <span className={`dot ${provider.status === 'ready' ? 'ok' : 'warn'}`} />
                  {STATUS[provider.status]}
                </span>
              </button>
              {configured && (
                <button
                  className="icon-btn"
                  aria-label={`Edit ${provider.label}`}
                  disabled={!online || busy}
                  onClick={() => setEditId(configured.id)}
                >
                  <Pencil size={15} />
                </button>
              )}
              {configured && (
                <button
                  className="icon-btn"
                  aria-label={`Remove ${provider.label}`}
                  disabled={!online || busy}
                  onClick={() => setRemoveId(configured.id)}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          )
        })}
      </div>
      {removeId && (
        <div className="settings-notice" role="alert">
          <p>
            Remove {agents.find((a) => a.id === removeId)?.label ?? 'this agent'} from this host?
            Its CLI and existing session history stay on the host.
          </p>
          <div className="settings-actions">
            <button
              className="settings-button"
              disabled={busy}
              onClick={() => setRemoveId(undefined)}
            >
              Cancel
            </button>
            <button
              className="settings-button danger"
              disabled={!online || busy}
              onClick={() => void remove()}
            >
              Remove agent
            </button>
          </div>
        </div>
      )}
      <div className="settings-card">
        <div className="setting-row">
          <div className="setting-label">
            <label htmlFor="default-agent">Default agent</label>
            <small id="default-agent-description">
              Used for new sessions on this host. You can pick another per session.
            </small>
          </div>
          <Select
            id="default-agent"
            aria-describedby="default-agent-description"
            disabled={!online}
            value={
              providers.some((p) => p.id === defaults.instanceId && p.status === 'ready')
                ? defaults.instanceId
                : ''
            }
            onChange={(e) => setDefaultAgent(hostId, e.target.value || undefined)}
          >
            <option value="">First available agent</option>
            {providers
              .filter((p) => p.status === 'ready')
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
          </Select>
        </div>
      </div>
      {current && (
        <>
          <div className="settings-section-head">
            <h3>Settings for</h3>
            <div className="settings-agent-tabs" role="tablist" aria-label="Agent settings">
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  role="tab"
                  aria-selected={current.id === provider.id}
                  onClick={() => setSelected(provider.id)}
                >
                  {provider.label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-card">
            {current.capabilities.models?.length ? (
              <div className="setting-row">
                <div className="setting-label">
                  <label htmlFor="default-model">Default model</label>
                  <small id="default-model-description">Used when you start a new session.</small>
                </div>
                <Select
                  id="default-model"
                  aria-describedby="default-model-description"
                  disabled={!online}
                  value={saved.model ?? ''}
                  onChange={(e) =>
                    setAgentDefaults(
                      hostId,
                      current.id,
                      modelChoice(
                        current.capabilities.models ?? [],
                        current.capabilities.efforts ?? [],
                        { ...saved, model: e.target.value || undefined },
                      ),
                    )
                  }
                >
                  <option value="">Agent default</option>
                  {current.capabilities.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            {efforts.length ? (
              <div className="setting-row">
                <div className="setting-label">
                  <label htmlFor="default-effort">Reasoning effort</label>
                  <small id="default-effort-description">
                    Higher effort may take longer and use more of your limit.
                  </small>
                </div>
                <Select
                  id="default-effort"
                  aria-describedby="default-effort-description"
                  disabled={!online}
                  value={saved.effort ?? ''}
                  onChange={(e) =>
                    setAgentDefaults(hostId, current.id, { effort: e.target.value || undefined })
                  }
                >
                  <option value="">Agent default</option>
                  {efforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            {permissionModes.length > 0 && (
              <div className="setting-row">
                <div className="setting-label">
                  <label htmlFor="default-mode">Default permission mode</label>
                  <small id="default-mode-description">
                    What this agent may do without asking.
                  </small>
                </div>
                <Select
                  id="default-mode"
                  aria-describedby="default-mode-description"
                  disabled={!online}
                  value={saved.permissionMode ?? ''}
                  onChange={(e) =>
                    setAgentDefaults(hostId, current.id, {
                      permissionMode: e.target.value || undefined,
                    })
                  }
                >
                  <option value="">Agent default</option>
                  {permissionModes.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {mode.label}
                      {mode.dangerous && !/full access/i.test(mode.label) ? ' · full access' : ''}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {permissionModes.find((m) => m.id === saved.permissionMode)?.dangerous && (
              <p className="settings-notice">
                New sessions will use this agent's full-access mode. It may change files and run
                commands without asking.
              </p>
            )}
            {!current.capabilities.models?.length &&
              !current.capabilities.efforts?.length &&
              permissionModes.length === 0 && (
                <p className="settings-empty">
                  {current.kind === 'acp' && online && !agentOffer?.failed
                    ? "Reading this agent's settings…"
                    : 'This agent reports its choices when a session starts. Its own configuration supplies the defaults.'}
                </p>
              )}
          </div>
        </>
      )}
      {(adding || editId) && (
        <AddAgentDialog
          hostKey={hostKey}
          agents={agents}
          editing={agents.find((a) => a.id === editId)}
          onClose={() => {
            setAdding(false)
            setEditId(undefined)
          }}
          onAdded={() => {
            setAdding(false)
            setEditId(undefined)
            void refresh()
          }}
        />
      )}
    </>
  )
}
