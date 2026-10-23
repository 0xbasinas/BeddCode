import { useState } from 'react'
import { ArrowRight, CircleCheck, CircleDot, CircleX, MinusCircle } from 'lucide-react'
import type { GitLog, PullRequest } from '@beddcode/contracts'
import { Markdown } from '../../ui/Markdown.tsx'
import { agoLabel } from '../../ui/format.ts'
import { hostRequest } from '../../stores/host.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import { usePolled } from './usePolled.ts'
import { GenerateGitText } from './GenerateGitText.tsx'

const CHECK_ICON = {
  success: <CircleCheck size={16} className="ok" />,
  failure: <CircleX size={16} className="bad" />,
  pending: <CircleDot size={16} className="wait" />,
  skipped: <MinusCircle size={16} className="muted" />,
}

export function PullRequestTab({
  cwd,
  branch,
  log,
  refreshKey,
  onChanged,
  sessionId,
  instanceId,
  defaultBase,
}: {
  cwd: string
  branch: string | undefined
  log: GitLog | undefined
  refreshKey: unknown
  onChanged(): void
  sessionId?: string
  instanceId?: string
  defaultBase?: string
}) {
  const hostKey = useHostKey()
  const pr = usePolled(
    () => hostRequest(hostKey, 'git.pr.get', { cwd }),
    `${hostKey}:${cwd}:${refreshKey}`,
    15_000,
  )

  if (pr.loading) return <div className="git-empty muted">Checking GitHub…</div>
  if (!pr.data) {
    return (
      <CreatePr
        cwd={cwd}
        branch={branch}
        log={log}
        sessionId={sessionId}
        instanceId={instanceId}
        defaultBase={defaultBase}
        availabilityError={pr.error}
        onCreated={() => (pr.refresh(), onChanged())}
      />
    )
  }
  return <PrDetails pr={pr.data} />
}

function PrDetails({ pr }: { pr: PullRequest }) {
  const passed = pr.checks.filter((c) => c.state === 'success').length
  const added = pr.files.reduce((n, f) => n + f.added, 0)
  const removed = pr.files.reduce((n, f) => n + f.removed, 0)
  return (
    <>
      <div className="git-scroll pr">
        <div className="pr-head">
          <span className={`state ${pr.state.toLowerCase()}`}>
            {pr.isDraft && pr.state === 'OPEN'
              ? 'Draft'
              : pr.state[0] + pr.state.slice(1).toLowerCase()}
          </span>
          <span className="muted">
            #{pr.number}
            {pr.createdAt ? ` · opened ${agoLabel(pr.createdAt)}` : ''}
          </span>
        </div>
        <h3>{pr.title}</h3>
        <div className="branches">
          <code>{pr.headBranch}</code> <ArrowRight size={13} /> <code>{pr.baseBranch}</code>
        </div>
        {pr.body && <Markdown text={pr.body} />}

        {pr.reviewDecision && (
          <div className="pr-section">
            <div className="section-title">Review</div>
            <div>{pr.reviewDecision.replace(/_/g, ' ').toLowerCase()}</div>
          </div>
        )}
        {pr.checks.length > 0 && (
          <div className="pr-section">
            <div className="section-title">
              Checks{' '}
              <span className="muted">
                {passed} of {pr.checks.length} passed
              </span>
            </div>
            {pr.checks.map((c) => (
              <div key={c.name} className="check-row">
                {CHECK_ICON[c.state]} <span>{c.name}</span>
              </div>
            ))}
          </div>
        )}
        {pr.files.length > 0 && (
          <div className="pr-section">
            <div className="section-title">
              Files changed · {pr.files.length}
              <span className="stat">
                <span className="add">+{added}</span> <span className="del">−{removed}</span>
              </span>
            </div>
            {pr.files.map((f) => (
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
      <div className="git-footer">
        <div className="git-actions">
          <a className="primary as-button" href={pr.url} target="_blank" rel="noreferrer">
            Open in GitHub
          </a>
        </div>
      </div>
    </>
  )
}

function CreatePr({
  cwd,
  branch,
  log,
  onCreated,
  sessionId,
  instanceId,
  defaultBase,
  availabilityError,
}: {
  cwd: string
  branch: string | undefined
  log: GitLog | undefined
  onCreated(): void
  sessionId?: string
  instanceId?: string
  defaultBase?: string
  availabilityError?: string
}) {
  const hostKey = useHostKey()
  const first = log ? [...log.unpushed, ...log.pushed].at(-1) : undefined
  const [title, setTitle] = useState(first?.subject ?? '')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [base, setBase] = useState(log?.base ?? defaultBase ?? 'main')
  const [generating, setGenerating] = useState(false)

  const create = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await hostRequest(hostKey, 'git.pr.create', {
        cwd,
        title: title.trim(),
        body,
        draft,
        base: base.trim(),
      })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const nothing = !log || log.unpushed.length + log.pushed.length === 0
  return (
    <>
      <div className="git-scroll pr">
        {availabilityError && (
          <div className="composer-error" role="alert">
            {availabilityError}. You can still generate and copy a draft.
          </div>
        )}
        <div className="pr-head">
          <span className="state none">No pull request</span>
        </div>
        <div className="branches">
          <code>{branch ?? 'HEAD'}</code> <ArrowRight size={13} /> <code>{base}</code>
        </div>
        {nothing ? (
          <div className="muted">Commit some changes on this branch first.</div>
        ) : (
          <>
            <label className="git-field-label">
              Base branch
              <input
                className="field"
                aria-label="Base branch"
                value={base}
                disabled={busy || generating}
                onChange={(e) => setBase(e.target.value)}
              />
            </label>
            <GenerateGitText
              sessionId={sessionId}
              cwd={cwd}
              preferredInstanceId={instanceId}
              kind="pr"
              base={base}
              disabled={busy || !base.trim() || branch === base.trim()}
              onBusy={setGenerating}
              onGenerated={(draft) => {
                setTitle(draft.title ?? '')
                setBody(draft.body ?? '')
              }}
            />
            <p className="muted small">
              Generates from committed changes compared with the base branch.
            </p>
            <input
              className="field"
              placeholder="Title"
              aria-label="Pull request title"
              readOnly={generating || busy}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className="field"
              placeholder="Describe the change"
              aria-label="Pull request description"
              readOnly={generating || busy}
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <label className="check-line">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              Open as draft
            </label>
            <div className="muted">Creating a pull request pushes this branch to GitHub first.</div>
          </>
        )}
        {error && <div className="composer-error">{error}</div>}
      </div>
      <div className="git-footer">
        <div className="git-actions">
          <button
            className="primary"
            disabled={
              Boolean(availabilityError) ||
              nothing ||
              busy ||
              generating ||
              !base.trim() ||
              branch === base.trim() ||
              title.trim().length === 0
            }
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Push & create pull request'}
          </button>
        </div>
      </div>
    </>
  )
}
