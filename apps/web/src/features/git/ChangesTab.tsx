import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Folder, Minus } from 'lucide-react'
import type { GitFile, GitStatus } from '@beddcode/contracts'
import { PatchView, type PatchReview } from '../../ui/PatchView.tsx'
import { reviewKey, useReviewComments, useReviewStore } from '../../stores/review.ts'
import { ReviewBar } from './ReviewBar.tsx'
import { hostRequest } from '../../stores/host.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import {
  commitLabel,
  diffRefreshKey,
  groupByDirectory,
  selectedPaths,
} from '@beddcode/client-runtime'
import { usePolled } from './usePolled.ts'
import { GenerateGitText } from './GenerateGitText.tsx'
import { commitFiles, gitOperationKey, useGitOperations } from './operations.ts'

const STATUS_COLOR: Record<GitFile['status'], string> = {
  M: 'var(--accent)',
  A: 'var(--success)',
  D: 'var(--danger)',
  R: 'var(--accent)',
}

export function ChangesTab({
  cwd,
  status,
  refreshKey,
  onChanged,
  sessionId,
  instanceId,
  onOpenCommits,
  onOpenPr,
  draftId,
}: {
  cwd: string
  /** Where "Add to message" stages the review: the composer of this pane's session or folder. */
  draftId?: string
  status: GitStatus
  /** Changes whenever the pane refreshes as a whole, so open diffs load again too. */
  refreshKey: string
  /** Called after a commit or push so the other tabs refresh. */
  onChanged(): void
  sessionId?: string
  instanceId?: string
  onOpenCommits(): void
  onOpenPr(): void
}) {
  const hostKey = useHostKey()
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState('')
  const operation = useGitOperations((s) => s.entries[gitOperationKey(hostKey, cwd)]?.operation)
  const busy = operation?.pending ? (operation.kind === 'commit' ? 'commit' : 'push') : null
  const [generating, setGenerating] = useState(false)
  const review = reviewKey(hostKey, cwd)
  const comments = useReviewComments(review)
  const addComment = useReviewStore((s) => s.add)
  const removeComment = useReviewStore((s) => s.remove)

  const groups = useMemo(() => groupByDirectory(status.files), [status.files])
  const selected = useMemo(() => selectedPaths(status.files, overrides), [status.files, overrides])
  const allSelected = selected.length === status.files.length && status.files.length > 0

  const toggleAll = () => {
    const next: Record<string, boolean> = {}
    for (const f of status.files) next[f.path] = !allSelected
    setOverrides(next)
  }

  const commit = async (push: boolean) => {
    try {
      await commitFiles(hostKey, {
        cwd,
        message: message.trim(),
        paths: selected,
        push,
      })
      setMessage('')
      setOverrides({})
      onChanged()
    } catch {
      /* The shared Git status keeps the result visible across tabs. */
    }
  }

  if (status.files.length === 0) {
    return (
      <div className="git-empty">
        <Check size={22} />
        <div>Nothing to commit</div>
        <div className="muted">Your working tree is clean.</div>
        <button className="secondary" onClick={onOpenCommits}>
          View commits & push
        </button>
        <button className="secondary" onClick={onOpenPr}>
          Open pull request
        </button>
      </div>
    )
  }

  const canCommit = selected.length > 0 && message.trim().length > 0 && busy === null && !generating
  const rowKey = (f: GitFile) => f.path

  return (
    <>
      <div className="git-scroll">
        <div className="select-row">
          <button
            className={`checkbox ${allSelected ? 'on' : selected.length > 0 ? 'some' : ''}`}
            onClick={toggleAll}
            aria-label="Select all"
            disabled={busy !== null}
          >
            {allSelected ? <Check size={13} /> : selected.length > 0 ? <Minus size={13} /> : null}
          </button>
          <span>
            {selected.length} of {status.files.length} selected
          </span>
          <span className="spacer" />
          <button
            className="link-btn"
            onClick={() =>
              setCollapsed(
                groups.every((g) => collapsed[g.dir])
                  ? {}
                  : Object.fromEntries(groups.map((g) => [g.dir, true])),
              )
            }
          >
            {groups.every((g) => collapsed[g.dir]) ? 'Expand all' : 'Collapse all'}
          </button>
        </div>

        {groups.map((group) => (
          <section key={group.dir}>
            {group.dir && (
              <button
                className="dir-row"
                onClick={() => setCollapsed((c) => ({ ...c, [group.dir]: !c[group.dir] }))}
              >
                {collapsed[group.dir] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <Folder size={14} /> {group.dir}
              </button>
            )}
            {!collapsed[group.dir] &&
              group.files.map((file) => {
                const checked = selected.includes(file.path)
                return (
                  <div key={rowKey(file)}>
                    <div className="change-row">
                      <button
                        className={`checkbox ${checked ? 'on' : ''}`}
                        aria-label={`Include ${file.path}`}
                        disabled={busy !== null}
                        onClick={() => setOverrides((o) => ({ ...o, [file.path]: !checked }))}
                      >
                        {checked && <Check size={13} />}
                      </button>
                      <button
                        className="change-name"
                        onClick={() => setOpen((o) => ({ ...o, [file.path]: !o[file.path] }))}
                        title={file.path}
                      >
                        {file.name}
                      </button>
                      <span className="stat">
                        <span className="add">+{file.added}</span>{' '}
                        <span className="del">−{file.removed}</span>
                      </span>
                      <span className="status-letter" style={{ color: STATUS_COLOR[file.status] }}>
                        {file.status}
                      </span>
                    </div>
                    {open[file.path] && (
                      <FileDiffView
                        cwd={cwd}
                        path={file.path}
                        refreshKey={diffRefreshKey(file, refreshKey)}
                        review={{
                          path: file.path,
                          comments: comments.filter((c) => c.path === file.path),
                          onAdd: (c) => addComment(review, c),
                          onRemove: (id) => removeComment(review, id),
                        }}
                      />
                    )}
                  </div>
                )
              })}
          </section>
        ))}
      </div>

      {comments.length > 0 && (
        <ReviewBar
          hostKey={hostKey}
          cwd={cwd}
          comments={comments}
          sessionId={sessionId}
          draftId={draftId}
          storeKey={review}
        />
      )}
      <div className="git-footer">
        <GenerateGitText
          sessionId={sessionId}
          cwd={cwd}
          preferredInstanceId={instanceId}
          kind="commit"
          paths={selected}
          disabled={selected.length === 0 || busy !== null}
          onBusy={setGenerating}
          onGenerated={(draft) => setMessage(draft.message ?? '')}
        />
        <div className="commit-box">
          <textarea
            value={message}
            aria-label="Commit message"
            placeholder="Summary, then an optional description"
            rows={4}
            readOnly={generating || busy !== null}
            onChange={(e) => setMessage(e.target.value)}
          />
          <span className="count">{message.length}</span>
        </div>
        <div className="git-actions">
          <button className="secondary" disabled={!canCommit} onClick={() => void commit(false)}>
            {busy === 'commit' ? 'Committing…' : commitLabel(selected.length)}
          </button>
          <button className="primary" disabled={!canCommit} onClick={() => void commit(true)}>
            {busy === 'push' ? 'Pushing…' : 'Commit & push'}
          </button>
        </div>
      </div>
    </>
  )
}

function FileDiffView({
  cwd,
  path,
  refreshKey,
  review,
}: {
  cwd: string
  path: string
  refreshKey: string
  review?: PatchReview
}) {
  const hostKey = useHostKey()
  // Reloads when the file's status changes, and on the same interval as the list, so an edit
  // that keeps the line counts the same still shows up.
  const diff = usePolled(() => hostRequest(hostKey, 'git.diff', { cwd, path }), refreshKey)
  if (diff.loading) return <div className="muted diff-note">Loading…</div>
  if (diff.error) return <div className="composer-error diff-note">{diff.error}</div>
  if (!diff.data || (diff.data.truncated && !diff.data.patch)) {
    return <div className="muted diff-note">Binary or very large file: no preview.</div>
  }
  return (
    <>
      <PatchView patch={diff.data.patch} review={review} />
      {diff.data.truncated && <div className="muted diff-note">Showing the first part only.</div>}
    </>
  )
}
