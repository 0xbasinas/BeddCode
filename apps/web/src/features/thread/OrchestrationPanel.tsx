import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { type SessionView } from '@beddcode/client-runtime'
import type { OrchestrationApproval } from '@beddcode/contracts'
import {
  isActive,
  progressSummary,
  touchedFiles,
  WORKER_STATE_LABEL,
  workerActivity,
  workerState,
} from './orchestrationModel.ts'
import { hostRequest, useHostStore, useRuntime } from '../../stores/host.ts'

const emptySessions: Record<string, SessionView> = {}
const COLLAPSED_KEY = 'beddcode.orchestration.collapsed'
const FILES_SHOWN = 3

function loadCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function WorkerCard({
  agent,
  prompt,
  worker,
  busy,
  onStop,
  onDecide,
}: {
  agent: string
  prompt: string
  worker?: SessionView
  busy: boolean
  onStop(): void
  onDecide(allow: boolean): void
}) {
  const [filesOpen, setFilesOpen] = useState(false)
  const state = workerState(worker)
  const files = touchedFiles(worker)
  const shown = filesOpen ? files : files.slice(0, FILES_SHOWN)
  const activity = workerActivity(worker)
  const head = (
    <>
      <span className={`orch-dot ${state}`} aria-hidden="true" />
      <span className="orch-agent">{agent}</span>
      {worker?.model && <span className="orch-model">{worker.model}</span>}
      <span className="orch-state">{WORKER_STATE_LABEL[state]}</span>
    </>
  )
  return (
    <li className="orch-card" data-state={state}>
      {worker ? (
        <Link
          className="orch-card-head"
          to="/session/$sessionId"
          params={{ sessionId: worker.id }}
          aria-label={`Open ${agent} thread`}
        >
          {head}
        </Link>
      ) : (
        <div className="orch-card-head">{head}</div>
      )}
      <p className="orch-task" title={prompt}>
        {prompt}
      </p>
      {activity && <p className="orch-activity">{activity}</p>}
      {files.length > 0 && (
        <div className="orch-files">
          <span>
            {files.length} {files.length === 1 ? 'file' : 'files'} touched
          </span>
          <ul>
            {shown.map((f) => (
              <li key={f} title={f}>
                {f.split('/').slice(-2).join('/')}
              </li>
            ))}
          </ul>
          {files.length > FILES_SHOWN && (
            <button type="button" className="orch-link" onClick={() => setFilesOpen(!filesOpen)}>
              {filesOpen ? 'Show fewer' : `Show all ${files.length}`}
            </button>
          )}
        </div>
      )}
      {worker && isActive(state) && (
        <div className="orch-actions">
          {state === 'waiting' && (
            <>
              <button type="button" disabled={busy} onClick={() => onDecide(true)}>
                Approve
              </button>
              <button type="button" disabled={busy} onClick={() => onDecide(false)}>
                Deny
              </button>
            </>
          )}
          <button type="button" disabled={busy} onClick={onStop}>
            Stop
          </button>
        </div>
      )}
    </li>
  )
}

export function OrchestrationPanel({
  session,
  hostKey,
}: {
  session: SessionView
  hostKey: string
}) {
  const sessions = useHostStore((s) => s.runtimes[hostKey]?.replica.sessions ?? emptySessions)
  const { connection, epoch } = useRuntime(hostKey)
  const [approvals, setApprovals] = useState<OrchestrationApproval[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      globalThis.localStorage?.setItem(COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      // Remembering the choice is optional.
    }
  }
  const load = useCallback(async () => {
    if (connection !== 'connected') return
    try {
      const items = await hostRequest(hostKey, 'orchestration.approvals.list', {})
      setApprovals(items.filter((a) => a.sessionId === session.id && a.status === 'pending'))
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [hostKey, session.id, connection])
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [load, epoch])
  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await action()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(undefined)
    }
  }
  const decide = (worker: SessionView, allow: boolean) => {
    const ask = worker.items.findLast(
      (i) => i.kind === 'approval' && !i.resolvedOptionId && !i.cancelled,
    )
    if (ask?.kind !== 'approval') return
    const option = ask.options.find((o) => o.kind === (allow ? 'allow' : 'deny'))
    if (!option) return
    void act(worker.id, () =>
      hostRequest(hostKey, 'sessions.approve', {
        sessionId: worker.id,
        requestId: ask.requestId,
        optionId: option.id,
      }),
    )
  }
  const plans = session.orchestrationPlans ?? []
  if (!plans.length && !approvals.length && !error) return null
  const workerFor = (planId: string, taskId: string) =>
    Object.values(sessions).find(
      (s) =>
        s.parent?.sessionId === session.id && s.parent.requestId === `plan:${planId}:${taskId}`,
    )
  const states = plans.flatMap((p) => p.tasks.map((t) => workerState(workerFor(p.planId, t.id))))
  const summary = states.length ? progressSummary(states) : 'No workers yet'
  return (
    <section className="orchestration-panel" aria-label="Orchestration">
      <button type="button" className="orch-head" aria-expanded={!collapsed} onClick={toggle}>
        <span className="orch-title">Orchestration</span>
        <span className="orch-summary">{summary}</span>
        <span className="orch-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {!collapsed && (
        <div className="orchestration-content">
          {error && <p role="alert">{error}</p>}
          {approvals.length > 0 && (
            <div className="orch-queue">
              <h3>Waiting for your approval</h3>
              {approvals.map((a) => (
                <div className="orch-card" key={a.id}>
                  <div className="orch-card-head">
                    <span className="orch-dot waiting" aria-hidden="true" />
                    <span className="orch-agent">
                      {a.kind === 'spawn' ? 'Start worker' : 'Send message'}
                    </span>
                    <small className="orch-state">
                      Expires {new Date(a.expiresAt).toLocaleTimeString()}
                    </small>
                  </div>
                  <p className="orch-task">{a.details}</p>
                  <div className="orch-actions">
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() =>
                        void act(a.id, () =>
                          hostRequest(hostKey, 'orchestration.approvals.approve', { id: a.id }),
                        )
                      }
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() =>
                        void act(a.id, () =>
                          hostRequest(hostKey, 'orchestration.approvals.deny', { id: a.id }),
                        )
                      }
                    >
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {plans.map((plan) => (
            <div className="orch-plan" key={plan.planId}>
              <p className="orch-goal">
                <small>Goal</small>
                {plan.goal}
              </p>
              <ul className="orch-workers">
                {plan.tasks.map((task) => {
                  const worker = workerFor(plan.planId, task.id)
                  return (
                    <WorkerCard
                      key={task.id}
                      agent={task.agent}
                      prompt={task.prompt}
                      worker={worker}
                      busy={!!busy}
                      onStop={() =>
                        worker &&
                        void act(worker.id, () =>
                          hostRequest(hostKey, 'sessions.interrupt', {
                            sessionId: worker.id,
                            includeChildren: true,
                          }),
                        )
                      }
                      onDecide={(allow) => worker && decide(worker, allow)}
                    />
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
