import { Fragment, useMemo, useState } from 'react'
import { MessageSquarePlus, Trash2 } from 'lucide-react'
import {
  commentAnchor,
  createReviewComment,
  numberPatch,
  type PatchLine,
  type ReviewComment,
} from '@beddcode/client-runtime'

/** A diff in the thread shows this many lines before a button for the rest. */
export const INLINE_PATCH_LINES = 120

/** Lets the reader comment on lines; the comments are kept by the caller. */
export interface PatchReview {
  path: string
  comments: readonly ReviewComment[]
  onAdd(comment: ReviewComment): void
  onRemove(id: string): void
}

/**
 * A unified-diff body: added lines green, removed red, hunk headers muted. With a `limit`, a longer
 * patch shows its first lines and a button for the rest: every line is a few elements, and a
 * thread with many large diffs would otherwise hold tens of thousands of them. With `review`, each
 * changed or context line gets a comment button (adapted from Paseo's diff review).
 */
export function PatchView({
  patch,
  limit = Infinity,
  review,
}: {
  patch: string
  limit?: number
  review?: PatchReview
}) {
  const [all, setAll] = useState(false)
  if (review) return <ReviewablePatch patch={patch} review={review} />
  const lines = patch.split('\n')
  const shown = all ? lines : lines.slice(0, limit)
  return (
    <>
      <pre className="patch">
        {shown.map((line, i) => {
          const metadata = /^(\+\+\+|---|@@|diff |index )/.test(line)
          const kind = metadata
            ? 'hunk'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : ''
          const prefixed = !metadata && /^[ +-]/.test(line)
          return (
            <div key={i} className={kind}>
              <span className="patch-sign" aria-hidden="true">
                {kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}
              </span>
              <span className="patch-code">{(prefixed ? line.slice(1) : line) || ' '}</span>
            </div>
          )
        })}
      </pre>
      {shown.length < lines.length && (
        <button className="patch-more" onClick={() => setAll(true)}>
          Show {lines.length - shown.length} more lines
        </button>
      )}
    </>
  )
}

const KIND_CLASS: Record<PatchLine['kind'], string> = {
  add: 'add',
  del: 'del',
  context: '',
  hunk: 'hunk',
  meta: 'hunk',
}

function ReviewablePatch({ patch, review }: { patch: string; review: PatchReview }) {
  const lines = useMemo(() => numberPatch(patch), [patch])
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const commentsAt = (line: PatchLine) => {
    const anchor = commentAnchor(line)
    return anchor
      ? review.comments.filter((c) => c.side === anchor.side && c.line === anchor.line)
      : []
  }
  const save = (index: number) => {
    const comment = createReviewComment({ path: review.path, lines, index, body: draft })
    if (comment) review.onAdd(comment)
    setEditing(null)
    setDraft('')
  }
  return (
    <pre className="patch reviewable">
      {lines.map((line, i) => {
        // Diff headers repeat what the file row already says.
        if (line.kind === 'meta' && /^(diff |index |--- |\+\+\+ )/.test(line.text)) return null
        const anchor = commentAnchor(line)
        const here = commentsAt(line)
        return (
          <Fragment key={i}>
            <div className={`${KIND_CLASS[line.kind]} ${here.length ? 'commented' : ''}`}>
              <span className="patch-num" aria-hidden="true">
                {line.kind === 'del' ? line.oldLine : (line.newLine ?? '')}
              </span>
              {anchor ? (
                <button
                  className="patch-comment-btn"
                  aria-label={`Comment on line ${anchor.line}`}
                  title="Comment on this line"
                  onClick={() => {
                    setEditing(i)
                    setDraft('')
                  }}
                >
                  <MessageSquarePlus size={12} />
                </button>
              ) : (
                <span className="patch-comment-btn" aria-hidden="true" />
              )}
              <span className="patch-sign" aria-hidden="true">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
              </span>
              <span className="patch-code">{line.text || ' '}</span>
            </div>
            {here.map((c) => (
              <div key={c.id} className="patch-comment">
                <span className="patch-comment-body">{c.body}</span>
                <button
                  className="icon-btn"
                  aria-label="Delete comment"
                  title="Delete comment"
                  onClick={() => review.onRemove(c.id)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {editing === i && (
              <div className="patch-comment editing">
                <textarea
                  autoFocus
                  rows={2}
                  value={draft}
                  aria-label="Comment"
                  placeholder="What should change here? Enter to add, Esc to cancel"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditing(null)
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      save(i)
                    }
                  }}
                />
                <div className="patch-comment-actions">
                  <button className="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                  <button className="primary" disabled={!draft.trim()} onClick={() => save(i)}>
                    Add comment
                  </button>
                </div>
              </div>
            )}
          </Fragment>
        )
      })}
    </pre>
  )
}
