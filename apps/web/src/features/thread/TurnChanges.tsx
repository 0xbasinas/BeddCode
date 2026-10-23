import { useState } from 'react'
import { ChevronDown, ChevronUp, FolderOpen, History, Undo2 } from 'lucide-react'
import type { TranscriptItem } from '@beddcode/client-runtime'
import type { GitDiff, TurnChangedFile } from '@beddcode/contracts'
import { PatchView } from '../../ui/PatchView.tsx'
import { hostRequest } from '../../stores/host.ts'
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
  canUndo,
  onOpenFile,
}: {
  item: Changes
  hostKey: string
  sessionId: string
  /** The newest changes of an idle session; older turns cannot be undone safely. */
  canUndo: boolean
  onOpenFile?(path: string): void
}) {
  const [open, setOpen] = useState(item.files.length <= 3 && !item.reverted)
  const [confirming, setConfirming] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [error, setError] = useState<string>()
  const added = item.files.reduce((n, f) => n + f.added, 0)
  const removed = item.files.reduce((n, f) => n + f.removed, 0)
  const count = item.files.length

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
            <PatchView patch={diff.patch} />
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
