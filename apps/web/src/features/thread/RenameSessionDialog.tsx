import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { SessionView } from '@beddcode/client-runtime'
import { hostRequest } from '../../stores/host.ts'

export function RenameSessionDialog({
  session,
  hostKey,
  onClose,
}: {
  session: SessionView
  hostKey: string
  onClose(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(session.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    input.current?.select()
    return () => {
      element.close()
      document.querySelector<HTMLButtonElement>('[aria-label="Session menu"]')?.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className="rename-dialog"
      aria-labelledby="rename-session-heading"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (busy || !title.trim()) return
          setBusy(true)
          setError(undefined)
          void hostRequest(hostKey, 'sessions.rename', {
            sessionId: session.id,
            title: title.trim(),
          })
            .then(onClose, (err: unknown) =>
              setError(err instanceof Error ? err.message : String(err)),
            )
            .finally(() => setBusy(false))
        }}
      >
        <header>
          <h2 id="rename-session-heading">Rename session</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <label htmlFor="session-title">Session name</label>
        <input
          ref={input}
          id="session-title"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={120}
          required
          disabled={busy}
        />
        {error && (
          <p className="approval-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" className="secondary-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary-btn" disabled={busy || !title.trim()}>
            {busy ? 'Saving…' : 'Save name'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
