import { useEffect, useRef, useState } from 'react'
import {
  defaultSwitchTarget,
  findSwitchTarget,
  handoffPrompt,
  switchTargets,
  type SessionView,
} from '@beddcode/client-runtime'
import type { ProviderInstance } from '@beddcode/contracts'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { hostRequest } from '../../stores/host.ts'

/** The switch request; only a reviewed note overrides the handoff the host builds. */
export function switchRequest(args: {
  sessionId: string
  instanceId: string
  model: string
  stop: boolean
  pendingMessage?: string
  reviewing: boolean
  handoff: string
}) {
  return {
    sessionId: args.sessionId,
    instanceId: args.instanceId,
    model: args.model || undefined,
    stop: args.stop,
    pendingMessage: args.pendingMessage || undefined,
    handoff: args.reviewing ? args.handoff : undefined,
  }
}

/** The label of the footer's primary action for the current step. */
export function primaryLabel(review: boolean, reviewing: boolean) {
  return review && !reviewing ? 'Review handoff' : reviewing ? 'Send and switch' : 'Switch'
}

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
  const targets = switchTargets(providers, session.instanceId)
  const fallback = defaultSwitchTarget(providers, session.instanceId)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [model, setModel] = useState('')
  const [review, setReview] = useState(
    () => localStorage.getItem('review-switch-handoff') === 'true',
  )
  const [handoff, setHandoff] = useState('')
  const [stop, setStop] = useState(false)
  // With review on, Switch first opens the note for editing; only its own button sends it.
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const previewRequest = useRef(0)
  const [completion, setCompletion] = useState<{ resolve(): void; reject(error: Error): void }>()
  const busy = session.status === 'running' || session.status === 'needs-you'
  const selected = targets.find((t) => t.ready && t.provider.id === target)?.provider
  const show = (agent?: string, callbacks?: { resolve(): void; reject(error: Error): void }) => {
    const found = agent
      ? findSwitchTarget(providers, session.instanceId, agent)
      : fallback
        ? { provider: fallback }
        : { error: 'No other agent is ready' }
    if ('error' in found) {
      callbacks?.reject(new Error(found.error))
      return
    }
    const match = found.provider
    setTarget(match.id)
    setModel('')
    setStop(false)
    setReviewing(false)
    setError('')
    setHandoff(
      handoffPrompt(session, {
        agentLabel: providers.find((p) => p.id === session.instanceId)?.label,
        pendingMessage: pendingMessage(),
      }),
    )
    setCompletion(callbacks)
    setOpen(true)
    loadPreview(match.id, !callbacks)
  }
  // The note names the target agent, so it is rebuilt for whichever agent is picked when review opens.
  const loadPreview = (instanceId: string, withPending: boolean) => {
    const request = ++previewRequest.current
    setLoadingPreview(true)
    void hostRequest(hostKey, 'session.switchAgent', {
      sessionId: session.id,
      instanceId,
      pendingMessage: withPending ? pendingMessage() || undefined : undefined,
      preview: true,
    })
      .then((result) => {
        if (request !== previewRequest.current) return
        if (!result.ok) throw new Error(result.error ?? 'Could not prepare handoff')
        setHandoff(result.draft)
      })
      .catch((e: unknown) => {
        if (request === previewRequest.current) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (request === previewRequest.current) setLoadingPreview(false)
      })
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
    if (review && !reviewing) {
      setReviewing(true)
      loadPreview(target, !completion)
      return
    }
    setSending(true)
    setError('')
    try {
      const result = await hostRequest(
        hostKey,
        'session.switchAgent',
        switchRequest({
          sessionId: session.id,
          instanceId: target,
          model,
          stop,
          pendingMessage: completion ? undefined : pendingMessage(),
          reviewing,
          handoff,
        }),
      )
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
      <button className="chip-lite" onClick={() => show()} disabled={!fallback}>
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
            width: 'min(380px, calc(100vw - 32px))',
          }}
        >
          <div className="session-panel-heading">Switch agent</div>
          <div className="flex flex-col gap-4">
            {!reviewing && (
              <>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Agent
                  <select
                    className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    value={target}
                    onChange={(e) => {
                      setTarget(e.target.value)
                      setModel('')
                    }}
                  >
                    {targets.map(({ provider: p, ready, reason }) => (
                      <option key={p.id} value={p.id} disabled={!ready}>
                        {ready ? p.label : `${p.label} (${reason})`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Model
                  <select
                    className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    <option value="">Default</option>
                    {selected?.capabilities.models?.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {!reviewing && busy && (
              <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                <p>A turn is running. Wait for it to finish, or stop it to switch.</p>
                <label className="flex items-center gap-2 text-foreground">
                  <input
                    type="checkbox"
                    checked={stop}
                    onChange={(e) => setStop(e.target.checked)}
                  />{' '}
                  Stop the turn
                </label>
              </div>
            )}
            {!reviewing && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-sm">
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
                  {review && (
                    <p className="text-sm text-muted-foreground">
                      The note is sent as written, with the next message. Sections you delete are
                      left out.
                    </p>
                  )}
                </div>
              </>
            )}
            {reviewing && (
              <>
                <p className="text-sm text-muted-foreground">
                  The note is sent as written, with the next message. Sections you delete are left
                  out.
                </p>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="switch-handoff">Handoff context</Label>
                  <Textarea
                    id="switch-handoff"
                    aria-label="Handoff context"
                    placeholder="Add handoff context"
                    className="min-h-40 max-h-80 resize-y overflow-y-auto"
                    disabled={loadingPreview}
                    value={handoff}
                    onChange={(e) => setHandoff(e.target.value)}
                    rows={10}
                  />
                </div>
              </>
            )}
            {error && (
              <p role="alert" className="composer-error">
                {error}
              </p>
            )}
          </div>
          <div className="switch-agent-footer">
            <Button type="button" variant="ghost" onClick={cancel} disabled={sending}>
              Cancel
            </Button>
            {reviewing && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setReviewing(false)}
                disabled={sending}
              >
                Back
              </Button>
            )}
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={sending || loadingPreview || (busy && !stop)}
            >
              {primaryLabel(review, reviewing)}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
