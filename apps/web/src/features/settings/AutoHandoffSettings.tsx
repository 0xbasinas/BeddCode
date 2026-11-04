import { useState } from 'react'
import { useRuntime } from '../../stores/host.ts'
import { defaultHandoffPolicy, useAutoHandoff } from '../../stores/autoHandoff.ts'
import type { HandoffMode } from '@beddcode/client-runtime'

export function AutoHandoffSettings({ hostKey }: { hostKey: string }) {
  const { providers, projects } = useRuntime(hostKey)
  const [project, setProject] = useState('')
  const host = useAutoHandoff((s) => s.hosts[hostKey])
  const update = useAutoHandoff((s) => s.setPolicy)
  const policy =
    (project ? host?.projects[project] : host?.global) ?? host?.global ?? defaultHandoffPolicy
  return (
    <>
      <div className="settings-section-head">
        <h3>Automatic handoff</h3>
      </div>
      <div className="settings-card">
        <p className="settings-notice">
          Choose an ordered list of agents for this host. Automatic handoff runs while this app is
          open.
        </p>
        <label>
          Scope{' '}
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.path}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Mode{' '}
          <select
            value={policy.mode}
            onChange={(e) =>
              update(hostKey, project, { ...policy, mode: e.target.value as HandoffMode })
            }
          >
            <option value="off">Off</option>
            <option value="ask">Ask with countdown</option>
            <option value="auto">Automatic</option>
          </select>
        </label>
        <p className="settings-notice">Fallback order (first available is used)</p>
        {policy.fallback.map((id, i) => (
          <div key={id}>
            {providers.find((p) => p.id === id)?.label ?? id}{' '}
            <button
              disabled={i === 0}
              onClick={() => {
                const next = [...policy.fallback]
                ;[next[i - 1], next[i]] = [next[i]!, next[i - 1]!]
                update(hostKey, project, { ...policy, fallback: next })
              }}
            >
              Move up
            </button>{' '}
            <button
              onClick={() =>
                update(hostKey, project, {
                  ...policy,
                  fallback: policy.fallback.filter((p) => p !== id),
                })
              }
            >
              Remove
            </button>
          </div>
        ))}
        <select
          aria-label="Add fallback agent"
          value=""
          onChange={(e) =>
            e.target.value &&
            update(hostKey, project, { ...policy, fallback: [...policy.fallback, e.target.value] })
          }
        >
          <option value="">Add ready agent…</option>
          {providers
            .filter((p) => p.status === 'ready' && !policy.fallback.includes(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
        </select>
        <p>
          <label>
            Maximum hops{' '}
            <input
              type="number"
              min={1}
              max={10}
              value={policy.maxHops}
              onChange={(e) =>
                update(hostKey, project, {
                  ...policy,
                  maxHops: Math.min(10, Math.max(1, Number(e.target.value) || 1)),
                })
              }
            />
          </label>
        </p>
      </div>
    </>
  )
}
