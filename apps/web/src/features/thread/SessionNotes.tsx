import { useEffect, useState } from 'react'
import type { SessionView } from '@beddcode/client-runtime'
import { hostRequest, useRuntime } from '../../stores/host.ts'

/** Host-backed notes use optimistic concurrency. Local drafts are never silently overwritten. */
export function SessionNotes({ session, hostKey }: { session: SessionView; hostKey: string }) {
  const key = `beddcode.session-notes:${hostKey}:${session.id}`
  const receiptKey = `${key}:operation`
  const remote = session.notes ?? { text: '', version: 0 }
  const { connection } = useRuntime(hostKey)
  const [base, setBase] = useState(() => {
    try {
      const local = localStorage.getItem(key)
      // A recovered browser draft has no saved host version. Compare it explicitly before
      // allowing it to replace notes already on the host.
      if (local !== null && local !== remote.text) return { ...remote, version: 0 }
    } catch {
      /* Storage error is shown if editing cannot be persisted. */
    }
    return remote
  })
  const [draft, setDraft] = useState(() => {
    try {
      return localStorage.getItem(key) ?? remote.text
    } catch {
      return remote.text
    }
  })
  const [operationId, setOperationId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(receiptKey)
    } catch {
      return null
    }
  })
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  const dirty = draft !== base.text
  const changed = remote.version > base.version
  // A clean client follows updates from another device immediately.
  if (changed && !dirty) {
    setBase(remote)
    setDraft(remote.text)
  }
  useEffect(() => {
    if (!operationId || saving || connection !== 'connected') return
    let active = true
    setChecking(true)
    void hostRequest(hostKey, 'sessions.notes.receipt', { sessionId: session.id, operationId })
      .then(({ saved }) => {
        if (!active || !saved) return
        setBase(saved)
        setOperationId(null)
        try {
          localStorage.removeItem(receiptKey)
        } catch {
          /* Keep the draft. */
        }
        setError(undefined)
      })
      .catch(() => {
        /* A missing or unreachable receipt leaves the outcome unknown. */
      })
      .finally(() => {
        if (active) setChecking(false)
      })
    return () => {
      active = false
    }
  }, [connection, hostKey, operationId, receiptKey, session.id, saving])
  const storeDraft = (text: string) => {
    setDraft(text)
    try {
      localStorage.setItem(key, text)
    } catch {
      setError(
        'This draft could not be saved locally. Keep this window open until you save it to the host.',
      )
    }
  }
  const save = async () => {
    const id = crypto.randomUUID()
    try {
      localStorage.setItem(receiptKey, id)
    } catch {
      setError('Could not save the operation locally. Please check browser storage and try again.')
      return
    }
    setOperationId(id)
    setSaving(true)
    setError(undefined)
    try {
      const saved = await hostRequest(hostKey, 'sessions.notes.set', {
        sessionId: session.id,
        text: draft,
        expectedVersion: base.version,
        operationId: id,
      })
      setBase(saved)
      setOperationId(null)
      try {
        localStorage.removeItem(receiptKey)
        localStorage.removeItem(key)
      } catch {
        /* Host copy has been saved. */
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (
        message !== 'connection lost' &&
        !message.includes('too long to answer') &&
        message !== 'client stopped'
      ) {
        setOperationId(null)
        try {
          localStorage.removeItem(receiptKey)
        } catch {
          /* No receipt to reconcile. */
        }
        setError(message)
      }
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="session-notes">
      <textarea
        aria-label="Session notes"
        placeholder="Notes for this session…"
        value={draft}
        maxLength={100_000}
        onChange={(event) => storeDraft(event.target.value)}
        disabled={saving}
      />
      {operationId && !saving && (
        <div className="banner" role="status">
          {checking
            ? 'Checking the save outcome…'
            : 'Save outcome unknown. Compare your draft with the latest notes before saving again.'}
          <textarea aria-label="Latest saved notes for comparison" value={remote.text} readOnly />
          {!checking && (
            <button
              onClick={() => {
                setOperationId(null)
                try {
                  localStorage.removeItem(receiptKey)
                } catch {
                  /* Draft remains available. */
                }
              }}
            >
              I have checked the notes
            </button>
          )}
        </div>
      )}
      {changed && dirty && (
        <div className="banner" role="status">
          Notes changed on another device. Your draft is preserved.
          <textarea aria-label="Latest saved notes" value={remote.text} readOnly />
          <button
            onClick={() => {
              setBase(remote)
              storeDraft(remote.text)
            }}
          >
            Use latest notes
          </button>
          <button onClick={() => setBase(remote)}>Keep my draft for another save</button>
        </div>
      )}
      <button
        disabled={saving || !!operationId || !dirty || changed || connection !== 'connected'}
        onClick={() => void save()}
      >
        {saving ? 'Saving…' : 'Save notes'}
      </button>
      <span role="status">
        {connection !== 'connected'
          ? 'Offline; draft kept locally'
          : dirty
            ? 'Unsaved draft'
            : 'Saved on host'}
      </span>
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
