import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { UsageLimits, UsageSummary } from '@beddcode/contracts'
import { hostRequest, useRuntime } from '../../stores/host.ts'
import {
  formatCost,
  formatReset,
  formatTokens,
  percentOfTotal,
  planName,
  shares,
  tokensOf,
} from './usageFormat.ts'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

function Bar({ percent, tone }: { percent: number; tone?: 'warn' | 'danger' }) {
  return (
    <span className={`usage-bar ${tone ?? ''}`} role="presentation">
      <span style={{ width: `${Math.max(percent > 0 ? 2 : 0, Math.min(100, percent))}%` }} />
    </span>
  )
}

/** What the agents on one host have used, and what their plans say is left. */
export function UsageSettings({ hostKey }: { hostKey: string }) {
  const { connection, epoch } = useRuntime(hostKey)
  const online = connection === 'connected'
  const [summary, setSummary] = useState<UsageSummary>()
  const [limits, setLimits] = useState<UsageLimits[]>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    if (!online) return () => {}
    let live = true
    setLoading(true)
    setError(undefined)
    // The summary is quick; the limits ask each agent's service and can take a few seconds.
    void hostRequest(hostKey, 'usage.summary', { days: 7 }).then(
      (s) => live && setSummary(s),
      (err: unknown) => live && setError(errorMessage(err)),
    )
    void hostRequest(hostKey, 'usage.limits', {})
      .then(
        (l) => live && setLimits(l),
        (err: unknown) => live && setError(errorMessage(err)),
      )
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [hostKey, online])

  useEffect(() => load(), [load, epoch])

  const withWindows = (limits ?? []).filter((l) => l.windows.length > 0)
  const withoutWindows = (limits ?? []).filter((l) => l.windows.length === 0 && l.note)
  const asked = limits !== undefined
  const agents = summary?.byAgent ?? []
  const agentPercents = percentOfTotal(agents, tokensOf)
  const models = summary?.byModel ?? []
  const modelPercents = percentOfTotal(models, tokensOf)
  const sessions = (summary?.bySession ?? []).slice(0, 5)
  const days = summary?.byDay ?? []
  const dayShares = shares(days, tokensOf)
  const total = summary ? tokensOf(summary.totals) : 0

  return (
    <>
      <div className="settings-toolbar">
        <button className="settings-button" onClick={() => load()} disabled={!online || loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      {withWindows.map((agent) => (
        <section key={agent.instanceId} aria-label={`${agent.label} plan`}>
          <div className="settings-card">
            <div className="setting-row">
              <div className="setting-label">
                <span>
                  {planName(agent.plan) ? `${planName(agent.plan)} plan` : 'Plan'} · {agent.label}
                </span>
                <small>Limits as {agent.label} reports them</small>
              </div>
            </div>
          </div>
          <div className="settings-section-head">
            <h3>Limits</h3>
          </div>
          <div className="settings-card">
            {agent.windows.map((w) => (
              <div className="setting-row usage-row" key={w.id}>
                <div className="setting-label">
                  <span>{w.label}</span>
                  <small>{formatReset(w.resetsAt)}</small>
                </div>
                <div className="usage-meter">
                  <Bar
                    percent={w.usedPercent}
                    tone={w.usedPercent >= 90 ? 'danger' : w.usedPercent >= 75 ? 'warn' : undefined}
                  />
                  <span className="usage-percent">{Math.round(w.usedPercent)}%</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {asked && withoutWindows.length > 0 && (
        <>
          <div className="settings-section-head">
            <h3>{withWindows.length > 0 ? 'No plan limits reported' : 'Plan limits'}</h3>
          </div>
          <div className="settings-card">
            {withoutWindows.map((agent) => (
              <div className="setting-row" key={agent.instanceId}>
                <div className="setting-label">
                  <span>{agent.label}</span>
                  <small>{agent.note}</small>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {asked && limits.length === 0 && (
        <p className="settings-empty">No agents are ready on this host yet.</p>
      )}
      {!limits && loading && (
        <p className="settings-empty">Asking your agents about their plans…</p>
      )}

      {agents.length > 0 && (
        <>
          <div className="settings-section-head">
            <h3>By agent · last 7 days</h3>
          </div>
          <div className="settings-card">
            {agents.map((a, i) => (
              <div className="setting-row usage-row" key={a.instanceId}>
                <div className="setting-label">
                  <span>{a.label}</span>
                  <small>
                    {[
                      `${a.reports} ${a.reports === 1 ? 'report' : 'reports'}`,
                      formatTokens(tokensOf(a)),
                      formatCost(a.costUsd),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </div>
                <div className="usage-meter">
                  <Bar percent={agentPercents[i] ?? 0} />
                  <span className="usage-percent">{agentPercents[i]}%</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="settings-section-head">
        <h3>By model · last 7 days</h3>
      </div>
      <div className="settings-card">
        {models.length === 0 ? (
          <p className="settings-empty">
            Nothing used yet. Usage appears here as agents finish turns.
          </p>
        ) : (
          models.map((m, i) => (
            <div className="setting-row usage-row" key={m.model}>
              <div className="setting-label">
                <span>{m.model}</span>
                <small>
                  {[formatTokens(tokensOf(m)), formatCost(m.costUsd)].filter(Boolean).join(' · ')}
                </small>
              </div>
              <div className="usage-meter">
                <Bar percent={modelPercents[i] ?? 0} />
                <span className="usage-percent">{modelPercents[i]}%</span>
              </div>
            </div>
          ))
        )}
      </div>

      {total > 0 && (
        <>
          <div className="settings-section-head">
            <h3>Per day</h3>
          </div>
          <div className="settings-card usage-days" role="img" aria-label="Tokens used per day">
            {days.map((d, i) => (
              <div
                className="usage-day"
                key={d.day}
                title={`${d.day}: ${formatTokens(tokensOf(d))}`}
              >
                <span className="usage-day-bar">
                  <span style={{ height: `${dayShares[i]}%` }} />
                </span>
                <small>
                  {new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, {
                    weekday: 'short',
                  })}
                </small>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="settings-section-head">
        <h3>Top sessions</h3>
      </div>
      <div className="settings-card">
        {sessions.length === 0 ? (
          <p className="settings-empty">No sessions have used anything in this period.</p>
        ) : (
          sessions.map((s) => (
            <div className="setting-row" key={s.sessionId}>
              <div className="setting-label">
                <span>{s.title}</span>
                {s.branch && <small className="mono">{s.branch}</small>}
              </div>
              <span className="usage-percent">{formatTokens(tokensOf(s))}</span>
            </div>
          ))
        )}
      </div>
      <p className="settings-footnote">
        Token counts come from what each agent reports after a turn, on this host. Agents that do
        not report usage (some ACP agents) do not appear.
      </p>
    </>
  )
}
