import { useEffect, useRef, useState } from 'react'
import {
  chooseHandoffAgent,
  detectHandoffTrigger,
  type SessionView,
} from '@beddcode/client-runtime'
import { createSession, prompt, refreshProviders, useHostStore } from '../../stores/host.ts'
import { defaultHandoffPolicy, useAutoHandoff } from '../../stores/autoHandoff.ts'
import { prepareHandoff } from '../../stores/handoff.ts'
import { composerDraftKey, useComposerDrafts } from '../composer/drafts.ts'

interface Pending {
  hostKey: string
  session: SessionView
  target: string
  label: string
  reason: string
  mode: 'ask' | 'auto'
}

/** Observe only new failures after synchronization, never replay old errors as new work. */
export function AutoHandoff() {
  const [pending, setPending] = useState<Pending>()
  const [seconds, setSeconds] = useState(10)
  const [error, setError] = useState<string>()
  const active = useRef(false)
  const seen = useRef(new Map<string, Set<string>>())
  useEffect(
    () =>
      useHostStore.subscribe((state) => {
        for (const [hostKey, runtime] of Object.entries(state.runtimes)) {
          if (!runtime.synced || runtime.connection !== 'connected') continue
          const previous = seen.current.get(hostKey)
          const current = new Set<string>()
          for (const session of Object.values(runtime.replica.sessions)) {
            if (session.turnStartedAt === undefined) {
              for (const item of session.items)
                if (item.kind === 'error') current.add(`${session.id}:${item.id}`)
            }
          }
          seen.current.set(hostKey, current)
          if (!previous || active.current) continue
          for (const session of Object.values(runtime.replica.sessions)) {
            if (
              session.status !== 'failed' ||
              session.turnStartedAt !== undefined ||
              session.handoffsTo?.length
            )
              continue
            const errors = session.items.filter((item) => item.kind === 'error')
            const latest = errors.at(-1)
            if (!latest || previous.has(`${session.id}:${latest.id}`)) continue
            const source = runtime.providers.find((p) => p.id === session.instanceId)
            if (!source) continue
            const reason = detectHandoffTrigger(source.kind, latest.message, errors.length)
            if (!reason) continue
            const settings = useAutoHandoff.getState().hosts[hostKey]
            const policy =
              settings?.projects[session.projectPath] ?? settings?.global ?? defaultHandoffPolicy
            const failed: Record<string, number> = { [session.instanceId]: Date.now() }
            let parent = session.handoffFrom?.sessionId
            let child = session.id
            let hops = 0
            const visited = new Set<string>()
            while (parent && !visited.has(parent)) {
              visited.add(parent)
              hops++
              const ancestor = runtime.replica.sessions[parent]
              if (!ancestor) break
              failed[ancestor.instanceId] =
                ancestor.handoffsTo?.find((h) => h.sessionId === child)?.at ?? ancestor.updatedAt
              child = ancestor.id
              parent = ancestor.handoffFrom?.sessionId
            }
            const target = chooseHandoffAgent(policy, runtime.providers, failed, hops)
            if (!target || policy.mode === 'off') continue
            active.current = true
            setSeconds(policy.mode === 'ask' ? 10 : 0)
            setPending({
              hostKey,
              session,
              target: target.id,
              label: target.label,
              reason: reason.slice(0, 1000),
              mode: policy.mode,
            })
            return
          }
        }
      }),
    [],
  )
  useEffect(() => {
    if (!pending) return
    if (seconds > 0) {
      const timer = setTimeout(() => setSeconds(seconds - 1), 1000)
      return () => clearTimeout(timer)
    }
    let cancelled = false
    void (async () => {
      try {
        const note = `${await prepareHandoff(pending.hostKey, pending.session, undefined, false)}\nHandoff reason: ${pending.reason}\nContinue from the latest state and decisions above.`
        // Keep a copy even if creation or sending fails.
        const draftKey = composerDraftKey(pending.hostKey, `handoff:${pending.session.id}`)
        useComposerDrafts.getState().setDraft(draftKey, note)
        useComposerDrafts
          .getState()
          .restoreDraft(composerDraftKey(pending.hostKey, pending.session.id), note)
        if (cancelled) return
        await refreshProviders(pending.hostKey)
        const runtime = useHostStore.getState().runtimes[pending.hostKey]
        if (!runtime?.providers.some((p) => p.id === pending.target && p.status === 'ready'))
          throw new Error('The fallback agent is no longer ready.')
        if (cancelled) return
        const id = await createSession(pending.hostKey, {
          instanceId: pending.target,
          handoffFrom: pending.session.id,
          handoffReason: pending.reason,
        })
        useComposerDrafts.getState().setDraft(composerDraftKey(pending.hostKey, id), note)
        await prompt(id, note, undefined, undefined, `automatic-handoff:${pending.session.id}`)
        useComposerDrafts.getState().setDraft(composerDraftKey(pending.hostKey, id), '')
        useComposerDrafts.getState().setDraft(draftKey, '')
        const sourceDraftKey = composerDraftKey(pending.hostKey, pending.session.id)
        if (useComposerDrafts.getState().drafts[sourceDraftKey] === note)
          useComposerDrafts.getState().setDraft(sourceDraftKey, '')
        setPending(undefined)
        active.current = false
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setPending(undefined)
        active.current = false
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pending, seconds])
  if (!pending && !error) return null
  return (
    <div
      role="status"
      className="settings-notice"
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 1000,
        maxWidth: 420,
        padding: 16,
        background: 'var(--background)',
      }}
    >
      {pending ? (
        <>
          Handing off to {pending.label} because {pending.reason}.{' '}
          {seconds > 0 && <>Continuing in {seconds}s. </>}
          <button
            disabled={seconds === 0}
            onClick={() => {
              setPending(undefined)
              active.current = false
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          {error} <button onClick={() => setError(undefined)}>Dismiss</button>
        </>
      )}
    </div>
  )
}
