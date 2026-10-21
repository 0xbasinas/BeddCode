import { useState } from 'react'
import { hostRequest } from '../../stores/host.ts'
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
  onChanged,
  onOpenPr,
}: {
  cwd: string
  log: GitLog
  hasUpstream: boolean
  onChanged(): void
  onOpenPr(): void
}) {
  const hostKey = useHostKey()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const push = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'git.push', { cwd })
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const n = log.unpushed.length
  if (n === 0 && log.pushed.length === 0) {
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
        {error && <div className="composer-error">{error}</div>}
        <div className="git-actions">
          {n > 0 ? (
            <button className="primary" disabled={busy} onClick={() => void push()}>
              {busy ? 'Pushing…' : n === 1 ? 'Push 1 commit' : `Push ${n} commits`}
            </button>
          ) : (
            <button className="primary" disabled>
              Everything is pushed
            </button>
          )}
          <button className="secondary" onClick={onOpenPr}>
            Open PR
          </button>
        </div>
      </div>
    </>
  )
}
