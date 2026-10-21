import { useRef, useState } from 'react'
import { Check, ChevronRight, CirclePause, Shield, X } from 'lucide-react'
import type { TranscriptItem } from '@beddcode/client-runtime'
import { Markdown } from '../../ui/Markdown.tsx'

type ApprovalItem = Extract<TranscriptItem, { kind: 'approval' }>

/** "Run this command?" reads better than the provider's "Running Bash: …" for a question. */
function questionTitle(title: string): string {
  return title.startsWith('Running ') ? 'Run this command?' : title
}

/** The first line of a detail, which is what fits on the row; the rest opens on request. */
function firstLine(text: string | undefined): string | undefined {
  return text
    ?.split('\n')
    .find((l) => l.trim())
    ?.trim()
}

/**
 * A permission request as compactly as it can be: what is being asked, the command it concerns, and
 * the choices, on one block. Once answered it shrinks to a single line.
 */
export function ApprovalCard({
  item,
  onApprove,
  cwd,
}: {
  item: ApprovalItem
  onApprove(requestId: string, optionId: string): void | Promise<void>
  cwd?: string
}) {
  const answered = item.options.find((o) => o.id === item.resolvedOptionId)
  const firstAllow = item.options.find((o) => o.kind === 'allow')
  const firstDeny = item.options.find((o) => o.kind === 'deny')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [showDetails, setShowDetails] = useState(false)
  const submitting = useRef(false)
  const resolved = Boolean(item.resolvedOptionId) || Boolean(item.cancelled)
  const state = item.cancelled
    ? 'cancelled'
    : !resolved
      ? 'pending'
      : answered?.kind === 'deny'
        ? 'denied'
        : answered?.kind === 'allow'
          ? 'allowed'
          : 'answered'

  const answer = async (optionId: string) => {
    if (submitting.current || resolved) return
    submitting.current = true
    setBusy(optionId)
    setError(undefined)
    try {
      await onApprove(item.requestId, optionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      submitting.current = false
      setBusy(undefined)
    }
  }

  const title = questionTitle(item.title)
  const preview = firstLine(item.detail)
  const multiline = (item.detail?.split('\n').filter((l) => l.trim()).length ?? 0) > 1

  // Answered: one quiet line, so a long session is not a wall of past permission prompts.
  if (resolved) {
    const Icon = state === 'allowed' ? Check : state === 'denied' ? X : CirclePause
    const verdict =
      state === 'allowed'
        ? answered?.label === 'Always for this session'
          ? 'Allowed for this session'
          : 'Allowed'
        : state === 'denied'
          ? 'Denied'
          : state === 'cancelled'
            ? 'Cancelled'
            : (answered?.label ?? 'Answered')
    return (
      <div className={`apv done ${state}`}>
        <Icon size={13} />
        <span className="apv-verdict">{verdict}</span>
        <span className="apv-what" title={item.detail ?? item.title}>
          {preview ? <code>{preview}</code> : title.replace(/\?$/, '')}
        </span>
      </div>
    )
  }

  return (
    <div className="apv pending">
      <div className="apv-head">
        <Shield size={14} className="apv-icon" />
        <span className="apv-title" title={item.title}>
          {title}
        </span>
        {(multiline || (cwd && !item.plan)) && (
          <button
            className="apv-more"
            aria-expanded={showDetails}
            aria-label="Details"
            onClick={() => setShowDetails((v) => !v)}
          >
            <ChevronRight size={14} className={showDetails ? 'open' : ''} />
          </button>
        )}
      </div>

      {preview && !showDetails && (
        <code className="apv-cmd" title={item.detail}>
          {preview}
        </code>
      )}
      {showDetails && (
        <div className="apv-details">
          {item.detail && (
            <pre>
              <code>{item.detail}</code>
            </pre>
          )}
          {cwd && (
            <code className="apv-cwd" title={cwd}>
              {cwd}
            </code>
          )}
        </div>
      )}
      {item.plan && (
        <div className="apv-plan">
          <Markdown text={item.plan} />
        </div>
      )}

      <div className="apv-actions">
        {item.options.map((o) => (
          <button
            key={o.id}
            id={`approval-${item.id}-${o.id}`}
            className={`apv-btn ${o.id === firstAllow?.id ? 'allow' : o.kind === 'deny' ? 'deny' : ''}`}
            disabled={Boolean(busy)}
            onClick={() => void answer(o.id)}
          >
            {busy === o.id ? 'Sending…' : o.label}
            {o.id === firstAllow?.id && <kbd>Enter</kbd>}
            {o.id === firstDeny?.id && <kbd>Esc</kbd>}
          </button>
        ))}
      </div>
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
