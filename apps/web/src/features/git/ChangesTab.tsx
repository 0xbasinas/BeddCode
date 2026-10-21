import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Folder, Minus } from 'lucide-react'
import type { GitFile, GitStatus } from '@beddcode/contracts'
import { PatchView } from '../../ui/PatchView.tsx'
import { hostRequest } from '../../stores/host.ts'
import { commitLabel, groupByDirectory, selectedPaths } from './changes.ts'
import { usePolled } from './usePolled.ts'

const STATUS_COLOR: Record<GitFile['status'], string> = {
  M: 'var(--accent)',
  A: 'var(--success)',
  D: 'var(--danger)',
  R: 'var(--accent)',
}

export function ChangesTab({
  cwd,
  status,
  onChanged,
}: {
  cwd: string
  status: GitStatus
  /** Called after a commit or push so the other tabs refresh. */
  onChanged(): void
}) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null)
  const [error, setError] = useState<string>()

  const groups = useMemo(() => groupByDirectory(status.files), [status.files])
  const selected = useMemo(() => selectedPaths(status.files, overrides), [status.files, overrides])
  const allSelected = selected.length === status.files.length && status.files.length > 0

  const toggleAll = () => {
    const next: Record<string, boolean> = {}
    for (const f of status.files) next[f.path] = !allSelected
    setOverrides(next)
  }

  const commit = async (push: boolean) => {
    setBusy(push ? 'push' : 'commit')
    setError(undefined)
    try {
      await hostRequest('git.commit', { cwd, message: message.trim(), paths: selected, push })
      setMessage('')
      setOverrides({})
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (status.files.length === 0) {
    return (
      <div className="git-empty">
        <Check size={22} />
        <div>Nothing to commit</div>
        <div className="muted">Your working tree is clean.</div>
      </div>
    )
  }

  const canCommit = selected.length > 0 && message.trim().length > 0 && busy === null
  const rowKey = (f: GitFile) => f.path

  return (
    <>
      <div className="git-scroll">
        <div className="select-row">
          <button
            className={`checkbox ${allSelected ? 'on' : selected.length > 0 ? 'some' : ''}`}
            onClick={toggleAll}
            aria-label="Select all"
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
                    {open[file.path] && <FileDiffView cwd={cwd} path={file.path} />}
                  </div>
                )
              })}
          </section>
        ))}
      </div>

      <div className="git-footer">
        <div className="commit-box">
          <textarea
            value={message}
            placeholder="Commit message"
            rows={2}
            onChange={(e) => setMessage(e.target.value)}
          />
          <span className="count">{message.length}</span>
        </div>
        {error && <div className="composer-error">{error}</div>}
        <div className="git-actions">
          <button className="primary" disabled={!canCommit} onClick={() => void commit(false)}>
            {busy === 'commit' ? 'Committing…' : commitLabel(selected.length)}
          </button>
          <button className="secondary" disabled={!canCommit} onClick={() => void commit(true)}>
            {busy === 'push' ? 'Pushing…' : 'Commit & push'}
          </button>
        </div>
      </div>
    </>
  )
}

function FileDiffView({ cwd, path }: { cwd: string; path: string }) {
  const diff = usePolled(() => hostRequest('git.diff', { cwd, path }), path, 0)
  if (diff.loading) return <div className="muted diff-note">Loading…</div>
  if (diff.error) return <div className="composer-error diff-note">{diff.error}</div>
  if (!diff.data || (diff.data.truncated && !diff.data.patch)) {
    return <div className="muted diff-note">Binary or very large file: no preview.</div>
  }
  return (
    <>
      <PatchView patch={diff.data.patch} />
      {diff.data.truncated && <div className="muted diff-note">Showing the first part only.</div>}
    </>
  )
}
