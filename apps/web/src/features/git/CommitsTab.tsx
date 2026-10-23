import { useState } from 'react'
import { gitOperationKey, pushBranch, useGitOperations } from './operations.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import type { GitCommit, GitLog } from '@beddcode/contracts'
import { agoLabel } from '../../ui/format.ts'

function initial(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || '?'
}

function CommitRow({ commit }: { commit: GitCommit }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`commit ${open ? 'open' : ''}`}>
      <button className="commit-main" onClick={() => setOpen((o) => !o)}>
        <span className="avatar round">{initial(commit.author)}</span>
        <span className="commit-text">
          <span className="commit-subject">{commit.subject}</span>
          <span className="commit-meta">
            <code>{commit.hash.slice(0, 7)}</code> {commit.author} · {agoLabel(commit.at)}{' '}
            <span className="stat">
              <span className="add">+{commit.added}</span>{' '}
              <span className="del">−{commit.removed}</span>
            </span>
          </span>
        </span>
      </button>
      {open && (
        <div className="commit-files">
          {commit.files.map((f) => (
            <div key={f.path} className="commit-file">
              <span className="file-path">{f.path}</span>
              <span className="stat">
                <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function CommitsTab({
  cwd,
  log,
  hasUpstream,
  refreshing,
  refreshError,
  onChanged,
  onOpenPr,
}: {
  cwd: string
  log: GitLog
  hasUpstream: boolean
  refreshing: boolean
  refreshError?: string
  onChanged(): void
  onOpenPr(): void
}) {
  const hostKey = useHostKey()
  const operation = useGitOperations((s) => s.entries[gitOperationKey(hostKey, cwd)]?.operation)
  const busy = Boolean(operation?.pending || refreshing)

  const push = async () => {
    try {
      await pushBranch(hostKey, cwd)
      onChanged()
    } catch {
      /* The shared Git status keeps the result visible across tabs. */
    }
  }

  const n = log.unpushed.length
  if (n === 0 && log.pushed.length === 0 && !busy) {
    return <div className="git-empty">No commits on this branch yet.</div>
  }

  return (
    <>
      <div className="git-scroll">
        {n > 0 && (
          <>
            <div className="section-title">Not pushed · {n}</div>
            {log.unpushed.map((c) => (
              <CommitRow key={c.hash} commit={c} />
            ))}
          </>
        )}
        {log.pushed.length > 0 && (
          <>
            <div className="section-title">{hasUpstream ? 'On origin' : 'Earlier'}</div>
            {log.pushed.map((c) => (
              <CommitRow key={c.hash} commit={c} />
            ))}
          </>
        )}
      </div>
      <div className="git-footer">
        {refreshError && (
          <div className="composer-error" role="alert">
            Could not refresh commits: {refreshError}
          </div>
        )}
        <div className="git-actions">
          {busy ? (
            <button className="primary" disabled>
              {operation?.pending
                ? operation.kind === 'commit'
                  ? 'Committing…'
                  : 'Pushing…'
                : 'Refreshing…'}
            </button>
          ) : n > 0 ? (
            <button className="primary" onClick={() => void push()}>
              {!hasUpstream ? 'Publish branch' : n === 1 ? 'Push 1 commit' : `Push ${n} commits`}
            </button>
          ) : (
            <button className="primary" disabled>
              Everything is pushed
            </button>
          )}
          <button className="secondary" disabled={busy} onClick={onOpenPr}>
            Open PR
          </button>
        </div>
      </div>
    </>
  )
}
