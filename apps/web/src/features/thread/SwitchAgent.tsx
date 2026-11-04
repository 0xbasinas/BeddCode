import { useEffect, useState } from 'react'
import { handoffPrompt, type SessionView } from '@beddcode/client-runtime'
import type { ProviderInstance } from '@beddcode/contracts'
import { hostRequest } from '../../stores/host.ts'

export function SwitchAgent({
  session,
  hostKey,
  providers,
  pendingMessage,
}: {
  session: SessionView
  hostKey: string
  providers: ProviderInstance[]
  pendingMessage(): string
}) {
  const ready = providers.filter((p) => p.status === 'ready' && p.id !== session.instanceId)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [model, setModel] = useState('')
  const [review, setReview] = useState(
    () => localStorage.getItem('review-switch-handoff') === 'true',
  )
  const [handoff, setHandoff] = useState('')
  const [stop, setStop] = useState(false)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [completion, setCompletion] = useState<{ resolve(): void; reject(error: Error): void }>()
  const busy = session.status === 'running' || session.status === 'needs-you'
  const selected = ready.find((p) => p.id === target)
  const show = (agent?: string, callbacks?: { resolve(): void; reject(error: Error): void }) => {
    const match = agent
      ? ready.find(
          (p) =>
            p.id.toLowerCase() === agent.toLowerCase() ||
            p.label.toLowerCase() === agent.toLowerCase(),
        )
      : ready[0]
    if (!match) {
      callbacks?.reject(new Error('No ready agent matches that name'))
      return
    }
    setTarget(match.id)
    setModel('')
    setStop(false)
    setError('')
    setHandoff(
      handoffPrompt(session, {
        agentLabel: providers.find((p) => p.id === session.instanceId)?.label,
        pendingMessage: pendingMessage(),
      }),
    )
    setCompletion(callbacks)
    setOpen(true)
    setLoadingPreview(true)
    void hostRequest(hostKey, 'session.switchAgent', {
      sessionId: session.id,
      instanceId: match.id,
      pendingMessage: callbacks ? undefined : pendingMessage() || undefined,
      preview: true,
    })
      .then((result) => {
        if (!result.ok) throw new Error(result.error ?? 'Could not prepare handoff')
        setHandoff(result.draft)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingPreview(false))
  }
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sessionId: string
          agent?: string
          resolve?: () => void
          reject?: (error: Error) => void
        }>
      ).detail
      if (detail.sessionId === session.id)
        show(
          detail.agent,
          detail.resolve && detail.reject
            ? { resolve: detail.resolve, reject: detail.reject }
            : undefined,
        )
    }
    window.addEventListener('switch-agent', listener)
    return () => window.removeEventListener('switch-agent', listener)
  })
  const cancel = () => {
    setOpen(false)
    completion?.reject(new Error('Switch cancelled'))
    setCompletion(undefined)
  }
  const submit = async () => {
    setSending(true)
    setError('')
    try {
      const result = await hostRequest(hostKey, 'session.switchAgent', {
        sessionId: session.id,
        instanceId: target,
        model: model || undefined,
        stop,
        pendingMessage: completion ? undefined : pendingMessage() || undefined,
        handoff: review ? handoff : undefined,
      })
      if (!result.ok) throw new Error(result.error ?? 'Could not switch agent')
      completion?.resolve()
      setCompletion(undefined)
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }
  return (
    <>
      <button className="chip-lite" onClick={() => show()} disabled={!ready.length}>
        Switch agent
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Switch agent"
          className="env-card"
          style={{
            position: 'absolute',
            right: 16,
            top: 55,
            zIndex: 20,
            padding: 16,
            minWidth: 300,
          }}
        >
          <div className="session-panel-heading">Switch agent</div>
          <label>
            Agent{' '}
            <select
              value={target}
              onChange={(e) => {
                setTarget(e.target.value)
                setModel('')
              }}
            >
              {ready.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {' '}
            Model{' '}
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Default</option>
              {selected?.capabilities.models?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {busy && (
            <p>
              A turn is running. Wait for it to finish, or stop it to switch.{' '}
              <label>
                <input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} />{' '}
                Stop the turn
              </label>
            </p>
          )}
          <p>
            <label>
              <input
                type="checkbox"
                checked={review}
                onChange={(e) => {
                  setReview(e.target.checked)
                  localStorage.setItem('review-switch-handoff', String(e.target.checked))
                }}
              />{' '}
              Review handoff before sending
            </label>
          </p>
          {review && (
            <textarea
              aria-label="Handoff context"
              disabled={loadingPreview}
              value={handoff}
              onChange={(e) => setHandoff(e.target.value)}
              rows={10}
              style={{ width: '100%' }}
            />
          )}
          {error && (
            <p role="alert" className="composer-error">
              {error}
            </p>
          )}
          <button onClick={cancel} disabled={sending}>
            Cancel
          </button>{' '}
          <button
            onClick={() => void submit()}
            disabled={sending || loadingPreview || (busy && !stop)}
          >
            Switch
          </button>
        </div>
      )}
    </>
  )
}
