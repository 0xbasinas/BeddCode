import { useState } from 'react'
import { MessageSquareText } from 'lucide-react'
import { formatReview, type ReviewComment } from '@beddcode/client-runtime'
import { prompt, upload, useSession } from '../../stores/host.ts'
import { useReviewStore } from '../../stores/review.ts'
import { stageAttachment } from '../composer/attachments.ts'

/**
 * The pending review under the changed files: send the comments to the session's agent now, or
 * attach them to the message being written. Only the comments that went out are cleared, so one
 * added while sending stays (the review flow is adapted from Paseo's).
 */
export function ReviewBar({
  hostKey,
  cwd,
  comments,
  sessionId,
  draftId,
  storeKey,
}: {
  hostKey: string
  cwd: string
  comments: readonly ReviewComment[]
  sessionId?: string
  draftId?: string
  storeKey: string
}) {
  const session = useSession(sessionId)
  const clearSent = useReviewStore((s) => s.clearSent)
  const [busy, setBusy] = useState<'send' | 'attach' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const count = comments.length

  const run = async (kind: 'send' | 'attach') => {
    const sent = [...comments]
    const text = formatReview({ cwd, comments: sent })
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'send') {
        await prompt(sessionId!, text)
      } else {
        const file = new File([text], 'review-comments.md', { type: 'text/markdown' })
        await stageAttachment(hostKey, draftId!, file.name, file.size, () => upload(hostKey, file))
      }
      clearSent(storeKey, sent)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the review')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="review-bar" role="region" aria-label="Review comments">
      <MessageSquareText size={14} />
      <span className="review-count">
        {count} {count === 1 ? 'comment' : 'comments'}
      </span>
      <span className="spacer" />
      <button
        className="secondary"
        disabled={busy !== null}
        onClick={() => clearSent(storeKey, comments)}
      >
        Clear
      </button>
      {draftId && (
        <button
          className="secondary"
          disabled={busy !== null}
          title="Attach the comments to the message you are writing"
          onClick={() => void run('attach')}
        >
          {busy === 'attach' ? 'Attaching…' : 'Attach'}
        </button>
      )}
      {sessionId && session && (
        <button
          className="primary"
          disabled={busy !== null}
          title={
            session.status === 'running'
              ? 'The agent is working: the review goes in as soon as it can take it'
              : 'Send the comments to the agent now'
          }
          onClick={() => void run('send')}
        >
          {busy === 'send' ? 'Sending…' : 'Send to agent'}
        </button>
      )}
      {error && <div className="composer-error review-error">{error}</div>}
    </div>
  )
}
