import { useState } from 'react'
import type { SessionView } from '@beddcode/client-runtime'
import { hostRequest, useRuntime } from '../../stores/host.ts'

/** Host-backed notes use optimistic concurrency. Local drafts are never silently overwritten. */
export function SessionNotes({ session, hostKey }: { session: SessionView; hostKey: string }) {
  const key = `beddcode.session-notes:${hostKey}:${session.id}`
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const dirty = draft !== base.text
  const changed = remote.version > base.version
  // A clean client follows updates from another device immediately.
  if (changed && !dirty) {
    setBase(remote)
    setDraft(remote.text)
  }
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
    setSaving(true)
    setError(undefined)
    try {
      const saved = await hostRequest(hostKey, 'sessions.notes.set', {
        sessionId: session.id,
        text: draft,
        expectedVersion: base.version,
      })
      setBase(saved)
      try {
        localStorage.removeItem(key)
      } catch {
        /* Host copy has been saved. */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
        disabled={saving || !dirty || changed || connection !== 'connected'}
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
