import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  FolderOpen,
  GitPullRequest,
  History,
  Undo2,
  Wrench,
} from 'lucide-react'
import { useUiStore } from '../../stores/ui.ts'
import type { TranscriptItem } from '@beddcode/client-runtime'
import type { GitDiff, TurnChangedFile } from '@beddcode/contracts'
import { INLINE_PATCH_LINES, PatchView } from '../../ui/PatchView.tsx'
import { hostRequest, prompt } from '../../stores/host.ts'
import { ciPrompt } from '../git/ciPrompt.ts'
import { refreshSessionPr, useSessionPr } from '../../stores/sessionPr.ts'
import { FileIcon } from '../files/FileIcon.tsx'

type Changes = Extract<TranscriptItem, { kind: 'changes' }>

const STATUS_LABEL: Record<TurnChangedFile['status'], string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
}

/**
 * What a turn really changed in the folder (the host compares snapshots from before and after the
 * turn, so commands and generated files count too). The latest turn's changes can be undone.
 */
export function TurnChangesCard({
  item,
  hostKey,
  sessionId,
  cwd,
  canUndo,
  offerPr,
  onOpenFile,
}: {
  item: Changes
  hostKey: string
  sessionId: string
  /** The session's folder, where its branch's pull request is looked up. */
  cwd: string
  /** The newest changes of an idle session; older turns cannot be undone safely. */
  canUndo: boolean
  /** In a worktree: offer to commit these and open a pull request from its branch. */
  offerPr?: boolean
  onOpenFile?(path: string): void
}) {
  const [open, setOpen] = useState(item.files.length <= 3 && !item.reverted)
  const [confirming, setConfirming] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [error, setError] = useState<string>()
  const [fixing, setFixing] = useState(false)
  const added = item.files.reduce((n, f) => n + f.added, 0)
  const removed = item.files.reduce((n, f) => n + f.removed, 0)
  const count = item.files.length
  const pr = useSessionPr(hostKey, cwd)
  const openPr = pr && pr.state === 'OPEN' ? pr : null
  const mergedPr = pr && pr.state === 'MERGED' ? pr : null
  // A turn just finished: ask GitHub now, so the pull request is already known (and the host has
  // it cached for the Git pane) by the time it is wanted.
  useEffect(() => {
    if (offerPr) void refreshSessionPr(hostKey, cwd)
  }, [offerPr, hostKey, cwd, item.id])

  // Gathers what CI said (the branch's Actions runs and the failed logs) and hands it to this agent.
  const fixCi = async () => {
    setFixing(true)
    setError(undefined)
    try {
      const report = await hostRequest(hostKey, 'git.ci.report', { cwd })
      await prompt(sessionId, ciPrompt(report))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setFixing(false)
    }
  }

  const undo = async () => {
    setUndoing(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'sessions.undoTurn', { sessionId, after: item.after })
      setConfirming(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUndoing(false)
    }
  }

  return (
    <div className={`edits turn-changes ${item.reverted ? 'reverted' : ''}`}>
      <div className="turn-changes-head">
        <button
          className="edits-head"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title="Every file this turn changed in the folder"
        >
          <History size={16} />
          <span>
            <strong>
              {item.reverted ? 'Undone: ' : ''}Changed {count === 1 ? '1 file' : `${count} files`}
              {item.truncated ? '+' : ''} this turn
            </strong>
            <span className="stat">
              <span className="add">+{added}</span> <span className="del">−{removed}</span>
            </span>
          </span>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {offerPr && !item.reverted && !confirming && openPr && (
          <>
            <button
              className="turn-undo"
              onClick={() => useUiStore.getState().showChanges()}
              title="Commit these in the Git pane; the pull request picks them up when pushed"
            >
              Commit
            </button>
            {openPr.checks === 'failure' && (
              <button
                className="turn-undo"
                disabled={fixing}
                onClick={() => void fixCi()}
                title="Send this agent the failing checks' logs from GitHub Actions to fix"
              >
                <Wrench size={14} /> {fixing ? 'Reading CI…' : 'Fix CI'}
              </button>
            )}
            <button
              className="turn-undo"
              onClick={() => useUiStore.getState().showPr()}
              title={`#${openPr.number} ${openPr.title}${
                openPr.checks === 'failure'
                  ? ` · ${openPr.checksFailed} checks failing`
                  : openPr.checks === 'pending'
                    ? ` · ${openPr.checksPending} checks running`
                    : openPr.checks === 'success'
                      ? ' · checks passed'
                      : ''
              }`}
            >
              <GitPullRequest size={14} /> PR #{openPr.number}
              {openPr.checks && openPr.checks !== 'skipped' && (
                <span className={`pr-checks ${openPr.checks}`} aria-hidden="true" />
              )}
            </button>
          </>
        )}
        {offerPr && !item.reverted && !confirming && mergedPr && (
          <button
            className="turn-undo"
            onClick={() => useUiStore.getState().showPr()}
            title="It was merged. Bring main up to date and remove this worktree and branch."
          >
            <GitPullRequest size={14} /> #{mergedPr.number} merged · Clean up
          </button>
        )}
        {offerPr && !item.reverted && !confirming && !openPr && !mergedPr && (
          <button
            className="turn-undo"
            onClick={() => useUiStore.getState().showChanges()}
            title="Commit these in the Git pane, then open a pull request from this worktree's branch"
          >
            <GitPullRequest size={14} /> Commit & PR
          </button>
        )}
        {canUndo && !item.reverted && !confirming && (
          <button
            className="turn-undo"
            onClick={() => setConfirming(true)}
            title="Put these files back the way they were before this turn"
          >
            <Undo2 size={14} /> Undo
          </button>
        )}
      </div>
      {confirming && (
        <div className="turn-undo-confirm" role="group" aria-label="Undo these changes">
          <span>
            {count === 1
              ? 'Put this file back the way it was before the turn?'
              : `Put these ${count} files back the way they were before the turn?`}{' '}
            Staged changes and commits stay as they are.
          </span>
          <button className="primary-btn" disabled={undoing} onClick={() => void undo()}>
            {undoing ? 'Undoing…' : 'Undo changes'}
          </button>
          <button className="secondary-btn" disabled={undoing} onClick={() => setConfirming(false)}>
            Keep
          </button>
        </div>
      )}
      {error && <div className="composer-error turn-undo-error">{error}</div>}
      {open &&
        item.files.map((file) => (
          <ChangedFile
            key={file.path}
            file={file}
            hostKey={hostKey}
            sessionId={sessionId}
            after={item.after}
            onOpenFile={item.reverted || file.status === 'D' ? undefined : onOpenFile}
          />
        ))}
    </div>
  )
}

function ChangedFile({
  file,
  hostKey,
  sessionId,
  after,
  onOpenFile,
}: {
  file: TurnChangedFile
  hostKey: string
  sessionId: string
  after: string
  onOpenFile?(path: string): void
}) {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<GitDiff | 'loading' | { error: string }>()
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && (diff === undefined || (typeof diff === 'object' && 'error' in diff))) {
      setDiff('loading')
      hostRequest(hostKey, 'sessions.turnDiff', { sessionId, after, path: file.path }).then(
        setDiff,
        (err: unknown) => setDiff({ error: err instanceof Error ? err.message : String(err) }),
      )
    }
  }
  return (
    <div className="file-diff">
      <div className="file-row" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        <button className="file-toggle" onClick={toggle} aria-expanded={open}>
          <FileIcon name={file.path} size={15} />
          <span className="file-path">
            {file.oldPath ? `${file.oldPath} → ` : ''}
            {file.path}
          </span>
          <span className={`file-status status-${file.status}`}>{STATUS_LABEL[file.status]}</span>
          {file.binary ? (
            <span className="stat muted">binary</span>
          ) : (
            <span className="stat">
              <span className="add">+{file.added}</span>{' '}
              <span className="del">−{file.removed}</span>
            </span>
          )}
        </button>
        {onOpenFile && (
          <button
            className="icon-btn file-open"
            aria-label={`Open ${file.path} in editor`}
            onClick={() => onOpenFile(file.path)}
          >
            <FolderOpen size={14} />
          </button>
        )}
        <button
          className="icon-btn file-disclosure"
          aria-label={`${open ? 'Collapse' : 'Expand'} diff for ${file.path}`}
          onClick={toggle}
        >
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>
      {open &&
        (diff === 'loading' || diff === undefined ? (
          <div className="turn-diff-note muted">Loading diff…</div>
        ) : 'error' in diff ? (
          <div className="turn-diff-note composer-error">{diff.error}</div>
        ) : diff.patch ? (
          <>
            <PatchView patch={diff.patch} limit={INLINE_PATCH_LINES} />
            {diff.truncated && <div className="turn-diff-note muted">Diff cut short</div>}
          </>
        ) : (
          <div className="turn-diff-note muted">
            {diff.truncated ? 'Binary file or too large to show' : 'No line changes'}
          </div>
        ))}
    </div>
  )
}
