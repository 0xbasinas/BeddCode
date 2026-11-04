import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { childPhase, type SessionView } from '@beddcode/client-runtime'
import type { OrchestrationApproval } from '@beddcode/contracts'
import { hostRequest, useHostStore, useRuntime } from '../../stores/host.ts'

const emptySessions: Record<string, SessionView> = {}
export function workerStatus(worker?: SessionView): string {
  if (!worker) return 'queued'
  const phase = childPhase(worker)
  if (phase === 'running' || phase === 'starting') return 'working'
  if (phase === 'needs-you') return 'blocked'
  if (worker.result && phase === 'done') return worker.result.status
  return (
    {
      starting: 'working',
      running: 'working',
      'needs-you': 'blocked',
      done: 'done',
      failed: 'failed',
      stopped: 'failed',
    } as const
  )[phase]
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
  const [open, setOpen] = useState(false)
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
  const plans = session.orchestrationPlans ?? []
  if (!plans.length && !approvals.length && !error) return null
  return (
    <section className="orchestration-panel">
      <button
        type="button"
        className="child-bar-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Orchestration · {plans.length} {plans.length === 1 ? 'plan' : 'plans'}
        {approvals.length > 0 && ` · ${approvals.length} awaiting approval`}
      </button>
      {open && (
        <div className="orchestration-content">
          {error && <p role="alert">{error}</p>}
          {approvals.length > 0 && (
            <div>
              <h3>Approval queue</h3>
              {approvals.map((a) => (
                <div className="orchestration-row" key={a.id}>
                  <strong>{a.kind === 'spawn' ? 'Start worker' : 'Send message'}</strong>
                  <p>{a.details}</p>
                  <small>Expires {new Date(a.expiresAt).toLocaleTimeString()}</small>
                  <div className="orchestration-actions">
                    <button
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
            <div key={plan.planId}>
              <h3>Goal</h3>
              <p>{plan.goal}</p>
              <h3>Tasks</h3>
              {plan.tasks.map((task) => {
                const worker = Object.values(sessions).find(
                  (s) =>
                    s.parent?.sessionId === session.id &&
                    s.parent.requestId === `plan:${plan.planId}:${task.id}`,
                )
                const status = workerStatus(worker)
                return (
                  <div className="orchestration-row" key={task.id}>
                    <strong>{task.agent}</strong> · {status}
                    <p>{task.prompt}</p>
                    {worker && (
                      <>
                        <Link to="/session/$sessionId" params={{ sessionId: worker.id }}>
                          Open worker session
                        </Link>
                        {worker.result && (
                          <p>
                            Report ({worker.result.status}): {worker.result.summary}
                          </p>
                        )}
                        {['starting', 'running', 'needs-you'].includes(childPhase(worker)) && (
                          <div className="orchestration-actions">
                            <button
                              disabled={!!busy}
                              onClick={() =>
                                void act(worker.id, () =>
                                  hostRequest(hostKey, 'sessions.interrupt', {
                                    sessionId: worker.id,
                                    includeChildren: true,
                                  }),
                                )
                              }
                            >
                              Stop worker
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
