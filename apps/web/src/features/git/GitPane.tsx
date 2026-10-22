import { useState } from 'react'
import { useUiStore } from '../../stores/ui.ts'
import { GitBranch } from 'lucide-react'
import type { SessionView } from '@beddcode/client-runtime'
import { hostRequest } from '../../stores/host.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import { ChangesTab } from './ChangesTab.tsx'
import { CommitsTab } from './CommitsTab.tsx'
import { PullRequestTab } from './PullRequestTab.tsx'
import { usePolled } from './usePolled.ts'

/**
 * Changes, commits and pull request of the folder a session works in. Git is read live (the
 * working tree changes outside our event log), refreshed on an interval and after each turn.
 */
export function GitPane({ session }: { session: SessionView }) {
  const tab = useUiStore((s) => s.gitTab)
  const setTab = useUiStore((s) => s.setGitTab)
  const [version, setVersion] = useState(0)
  const cwd = session.cwd
  const hostKey = useHostKey()
  // A finished turn usually means files changed.
  const key = `${hostKey}:${cwd}:${session.status}:${version}`

  const info = usePolled(() => hostRequest(hostKey, 'git.info', { cwd }), key)
  const status = usePolled(() => hostRequest(hostKey, 'git.status', { cwd }), key)
  const log = usePolled(() => hostRequest(hostKey, 'git.log', { cwd }), key, 8000)

  const changed = () => {
    setVersion((v) => v + 1)
  }

  if (info.loading) return <div className="git-empty muted">Loading…</div>
  if (info.error) {
    return (
      <div className="git-empty">
        <div>Git is unavailable here</div>
        <div className="muted">{info.error}</div>
      </div>
    )
  }
  if (!info.data?.isRepo) {
    return (
      <div className="git-empty">
        <GitBranch size={22} />
        <div>This folder is not a git repository</div>
        <div className="muted">Run `git init` in it to track changes here.</div>
      </div>
    )
  }

  const files = status.data?.files ?? []
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)

  return (
    <div className="git-pane">
      <div className="git-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')}>
          Changes {files.length > 0 && <span className="badge-lite">{files.length}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'commits'} onClick={() => setTab('commits')}>
          Commits
        </button>
        <button role="tab" aria-selected={tab === 'pr'} onClick={() => setTab('pr')}>
          PR
        </button>
      </div>

      <div className="git-branch">
        <GitBranch size={15} />
        <code>{info.data.branch ?? 'detached HEAD'}</code>
        {(info.data.ahead ?? 0) > 0 && <span className="add">↑{info.data.ahead}</span>}
        {(info.data.behind ?? 0) > 0 && <span className="del">↓{info.data.behind}</span>}
        <span className="spacer" />
        {tab === 'commits' && log.data?.base ? (
          <span className="muted">vs {log.data.base}</span>
        ) : (
          (added > 0 || removed > 0) && (
            <span className="stat">
              <span className="add">+{added}</span> <span className="del">−{removed}</span>
            </span>
          )
        )}
      </div>

      {tab === 'changes' &&
        (status.data ? (
          <ChangesTab cwd={cwd} status={status.data} refreshKey={key} onChanged={changed} />
        ) : (
          <div className="git-empty muted">{status.error ?? 'Loading…'}</div>
        ))}
      {tab === 'commits' &&
        (log.data ? (
          <CommitsTab
            cwd={cwd}
            log={log.data}
            hasUpstream={Boolean(info.data.upstream)}
            onChanged={changed}
            onOpenPr={() => setTab('pr')}
          />
        ) : (
          <div className="git-empty muted">{log.error ?? 'Loading…'}</div>
        ))}
      {tab === 'pr' && (
        <PullRequestTab
          cwd={cwd}
          branch={info.data.branch}
          log={log.data}
          refreshKey={version}
          onChanged={changed}
        />
      )}
    </div>
  )
}
