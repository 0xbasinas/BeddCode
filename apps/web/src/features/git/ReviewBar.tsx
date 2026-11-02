import { useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { MessageSquareText } from 'lucide-react'
import { formatReview, reviewPatchVersion, type ReviewComment } from '@beddcode/client-runtime'
import { hostRequest, prompt, upload, useSession } from '../../stores/host.ts'
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
  const [stale, setStale] = useState<string[]>([])
  const [allowStale, setAllowStale] = useState(false)
  const count = comments.length

  const run = async (kind: 'send' | 'attach') => {
    const sent = [...comments]
    setBusy(kind)
    setError(null)
    try {
      const versions = new Map<string, string | null>()
      await Promise.all(
        [...new Set(sent.map((c) => c.path))].map(async (path) => {
          try {
            const diff = await hostRequest(hostKey, 'git.diff', { cwd, path })
            versions.set(path, diff.truncated ? null : reviewPatchVersion(diff.patch))
          } catch {
            versions.set(path, null)
          }
        }),
      )
      const outdated = sent.filter(
        (c) => !c.patchVersion || versions.get(c.path) !== c.patchVersion,
      )
      setStale(outdated.map((c) => c.id))
      if (outdated.length && !allowStale)
        throw new Error(
          'Some review comments refer to a changed or unavailable diff. Review their captured context below before sending.',
        )
      const text =
        (outdated.length
          ? 'These comments include earlier diff context. Files have changed or could not be verified; check their current contents before acting.\n\n'
          : '') + formatReview({ cwd, comments: sent })
      if (kind === 'send') {
        await prompt(sessionId!, text)
      } else {
        const file = new File([text], 'review-comments.md', { type: 'text/markdown' })
        const attached = await stageAttachment(hostKey, draftId!, file.name, file.size, () =>
          upload(hostKey, file),
        )
        if (!attached) throw new Error('Could not attach the review; your comments are still here')
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
      <Button
        variant="app"
        className="secondary"
        disabled={busy !== null}
        onClick={() => clearSent(storeKey, comments)}
      >
        Clear
      </Button>
      {draftId && (
        <Button
          variant="app"
          className="secondary"
          disabled={busy !== null}
          title="Attach the comments to the message you are writing"
          onClick={() => void run('attach')}
        >
          {busy === 'attach' ? 'Attaching…' : 'Attach'}
        </Button>
      )}
      {sessionId && session && (
        <Button
          variant="app"
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
        </Button>
      )}
      {error && <div className="composer-error review-error">{error}</div>}
      {stale.length > 0 && (
        <div className="review-error" role="region" aria-label="Comments needing review">
          {comments
            .filter((c) => stale.includes(c.id))
            .map((c) => (
              <details key={c.id}>
                <summary>
                  {c.path}:{c.line} — captured context may be stale
                </summary>
                <pre>{c.context.lines.map((line) => line.text).join('\n')}</pre>
                <textarea
                  aria-label={`Edit review comment for ${c.path}:${c.line}`}
                  value={c.body}
                  onChange={(e) => useReviewStore.getState().edit(storeKey, c.id, e.target.value)}
                />
                <button onClick={() => useReviewStore.getState().remove(storeKey, c.id)}>
                  Remove comment
                </button>
              </details>
            ))}
          <label className="check-row">
            <Checkbox
              checked={allowStale}
              onCheckedChange={(checked) => setAllowStale(checked === true)}
            />
            Send original captured context even if the diff has changed
          </label>
        </div>
      )}
    </div>
  )
}
