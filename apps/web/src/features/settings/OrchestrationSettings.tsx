import { useEffect, useState } from 'react'
import type { OrchestrationLimits, OrchestrationSettings as Settings } from '@beddcode/contracts'
import { hostRequest, useRuntime } from '../../stores/host.ts'

const fields = [
  ['maxDepth', 'Maximum nesting depth', 100],
  ['maxWorkers', 'Maximum workers per session', 1000],
  ['maxTotalWorkers', 'Maximum total workers', 10000],
  ['maxMessagesPerMinute', 'Messages per minute', 10000],
  ['maxMessages', 'Maximum messages per thread', 10000],
] as const

type Key = (typeof fields)[number][0]
export function OrchestrationSettings({ hostKey }: { hostKey: string }) {
  const { connection, epoch } = useRuntime(hostKey)
  const [settings, setSettings] = useState<Settings>()
  const [project, setProject] = useState('')
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    setSettings(undefined)
    if (connection === 'connected')
      void hostRequest(hostKey, 'orchestration.settings.get', {})
        .then((s) => {
          if (active) {
            setSettings(s)
            setError(undefined)
          }
        })
        .catch((e: unknown) => {
          if (active) setError(String(e))
        })
    return () => {
      active = false
    }
  }, [hostKey, connection, epoch])
  const overrides = project ? (settings?.projects[project] ?? {}) : undefined
  const update = (patch: Partial<OrchestrationLimits>) => {
    if (!settings) return
    setSaved(false)
    setSettings(
      project
        ? { ...settings, projects: { ...settings.projects, [project]: { ...overrides, ...patch } } }
        : { ...settings, global: { ...settings.global, ...patch } },
    )
  }
  const clear = (key: keyof OrchestrationLimits) => {
    if (!settings || !project) return
    const next = { ...overrides }
    delete next[key]
    const projects = { ...settings.projects }
    if (Object.keys(next).length) projects[project] = next
    else delete projects[project]
    setSettings({ ...settings, projects })
    setSaved(false)
  }
  const save = async () => {
    if (!settings) return
    setBusy(true)
    setError(undefined)
    try {
      setSettings(await hostRequest(hostKey, 'orchestration.settings.set', settings))
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="orchestration-settings">
      <p className="muted">
        Set limits for agent collaboration on this host. Project overrides use the exact project
        path.
      </p>
      <label>
        Project path (leave empty for global settings)
        <input
          value={project}
          onChange={(e) => {
            setProject(e.target.value)
            setSaved(false)
          }}
          placeholder="Global settings"
        />
      </label>
      {settings && (
        <>
          {fields.map(([key, label, max]) => (
            <label key={key}>
              {label}
              <span className="orchestration-setting-control">
                <input
                  type="number"
                  min={0}
                  max={max}
                  step={1}
                  value={project ? (overrides?.[key] ?? '') : settings.global[key]}
                  placeholder={String(settings.global[key])}
                  onChange={(e) => {
                    if (project && e.target.value === '') clear(key)
                    else update({ [key]: e.target.valueAsNumber } as Pick<OrchestrationLimits, Key>)
                  }}
                />
                {project && <small>Global: {settings.global[key]}</small>}
              </span>
            </label>
          ))}
          <label>
            Approval mode
            <select
              value={project ? (overrides?.approval ?? '') : settings.global.approval}
              onChange={(e) => {
                if (!e.target.value) clear('approval')
                else update({ approval: e.target.value as OrchestrationLimits['approval'] })
              }}
            >
              {project && <option value="">Use global setting</option>}
              <option value="off">Off</option>
              <option value="approve-spawns">Approve worker starts</option>
              <option value="approve-spawns-and-messages">
                Approve worker starts and messages
              </option>
            </select>
          </label>
          <button
            className="settings-button primary"
            type="button"
            disabled={busy}
            onClick={() => void save()}
          >
            Save settings
          </button>
          {saved && <span role="status"> Settings saved</span>}
        </>
      )}
      {connection !== 'connected' && <p>Host disconnected.</p>}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
