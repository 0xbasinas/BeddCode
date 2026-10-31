import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { confirmDialog } from '../../ui/confirm.tsx'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  CircleDot,
  CircleX,
  Copy,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MinusCircle,
  Plus,
  RotateCw,
} from 'lucide-react'
import { BrandIcon } from '../../ui/BrandIcon.tsx'
import type {
  GithubStatus,
  GitLog,
  PrCheckState,
  PrFilter,
  PullRequest,
  PullRequestSummary,
} from '@beddcode/contracts'
import {
  MERGE_METHOD_LABEL,
  PR_FILTERS,
  PR_STATE_LABEL,
  checkCounts,
  checksLabel,
  checksSummary,
  commentText,
  githubProblem,
  cleanupLines,
  mergeBlocker,
  mergeReadiness,
  prDraftFromCommits,
  prStateKind,
  reviewLabel,
  reviewStateLabel,
  syncPrompt,
  type MergeLocalState,
  type PrStateKind,
  type ReadinessItem,
} from '@beddcode/client-runtime'
import { Markdown } from '../../ui/Markdown.tsx'
import { agoLabel } from '../../ui/format.ts'
import { hostRequest, prompt } from '../../stores/host.ts'
import { refreshSessionPr } from '../../stores/sessionPr.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import { useUiStore } from '../../stores/ui.ts'
import { usePolled } from './usePolled.ts'
import { GenerateGitText } from './GenerateGitText.tsx'

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

const CHECK_ICON: Record<PrCheckState, React.ReactNode> = {
  success: <CircleCheck size={15} className="ok" />,
  failure: <CircleX size={15} className="bad" />,
  pending: <CircleDot size={15} className="wait" />,
  skipped: <MinusCircle size={15} className="muted" />,
}

function PrStateIcon({ kind, size = 16 }: { kind: PrStateKind; size?: number }) {
  const Icon =
    kind === 'merged'
      ? GitMerge
      : kind === 'closed'
        ? GitPullRequestClosed
        : kind === 'draft'
          ? GitPullRequestDraft
          : GitPullRequest
  return <Icon size={size} className={`pr-icon ${kind}`} aria-label={PR_STATE_LABEL[kind]} />
}

function ReviewBadge({ decision }: { decision?: string }) {
  const label = reviewLabel(decision)
  if (!label) return null
  return <span className={`pr-review ${decision?.toLowerCase()}`}>{label}</span>
}

type View = { kind: 'list' } | { kind: 'detail'; number: number } | { kind: 'create' }

/**
 * Pull requests of the folder's GitHub repo, through the host's own `gh`: a filtered list with
 * this branch's pull request on top, one pull request in full with its actions, and a form for
 * a new one from the current branch.
 */
export function PullRequestTab({
  cwd,
  branch,
  log,
  refreshKey,
  onChanged,
  sessionId,
  instanceId,
  defaultBase,
  ahead,
  hasUpstream,
  uncommitted,
  isWorktree,
}: {
  cwd: string
  branch: string | undefined
  log: GitLog | undefined
  refreshKey: unknown
  onChanged(): void
  sessionId?: string
  instanceId?: string
  defaultBase?: string
  ahead?: number
  hasUpstream?: boolean
  /** Files changed in the folder and not committed. */
  uncommitted?: number
  /** The folder is a linked worktree. */
  isWorktree?: boolean
}) {
  const hostKey = useHostKey()
  const [view, setView] = useState<View>({ kind: 'list' })
  const [statusKey, setStatusKey] = useState(0)
  const status = usePolled(
    () => hostRequest(hostKey, 'git.gh.status', { cwd }),
    `${hostKey}:${cwd}:${statusKey}`,
    0,
  )
  // "Create pull request" elsewhere (the worktree menu) lands here on the form.
  const createAsk = useUiStore((s) => s.prCreateAsk)
  const seenAsk = useRef(createAsk)
  useEffect(() => {
    if (createAsk !== seenAsk.current) {
      seenAsk.current = createAsk
      setView({ kind: 'create' })
    }
  }, [createAsk])
  useEffect(() => setView({ kind: 'list' }), [cwd])

  if (status.loading) return <div className="git-empty muted">Checking GitHub…</div>
  const gh = status.data
  const problem = status.error
    ? { title: 'GitHub is unavailable', detail: status.error }
    : githubProblem(gh)
  if (problem || gh?.state !== 'ready') {
    return (
      <GithubProblem
        problem={problem ?? { title: 'GitHub is unavailable', detail: '' }}
        onRetry={() => setStatusKey((k) => k + 1)}
      />
    )
  }

  if (view.kind === 'create') {
    return (
      <CreatePr
        cwd={cwd}
        branch={branch}
        log={log}
        sessionId={sessionId}
        instanceId={instanceId}
        defaultBase={log?.base ?? gh.defaultBranch ?? defaultBase}
        needsPush={!hasUpstream || (ahead ?? 0) > 0}
        onCancel={() => setView({ kind: 'list' })}
        onCreated={(number) => {
          onChanged()
          setView(number ? { kind: 'detail', number } : { kind: 'list' })
        }}
      />
    )
  }
  if (view.kind === 'detail') {
    return (
      <PrDetailView
        cwd={cwd}
        number={view.number}
        gh={gh}
        refreshKey={refreshKey}
        onBack={() => setView({ kind: 'list' })}
        onChanged={onChanged}
        sessionId={sessionId}
        branch={branch}
        ahead={ahead}
        uncommitted={uncommitted}
        isWorktree={isWorktree}
      />
    )
  }
  return (
    <PrList
      cwd={cwd}
      gh={gh}
      branch={branch}
      refreshKey={refreshKey}
      onOpen={(number) => setView({ kind: 'detail', number })}
      onCreate={() => setView({ kind: 'create' })}
    />
  )
}

function GithubProblem({
  problem,
  onRetry,
}: {
  problem: { title: string; detail: string; command?: string; link?: string }
  onRetry(): void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="git-empty gh-problem">
      <BrandIcon brand="github" size={22} />
      <div className="gh-problem-title">{problem.title}</div>
      {problem.detail && <div className="muted">{problem.detail}</div>}
      {problem.command && (
        <div className="gh-command">
          <code>{problem.command}</code>
          <Button
            variant="app"
            className="icon-btn small"
            aria-label="Copy command"
            title="Copy"
            onClick={() => {
              void navigator.clipboard?.writeText(problem.command!)
              setCopied(true)
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </Button>
        </div>
      )}
      <div className="gh-problem-actions">
        {problem.link && (
          <a className="secondary as-button" href={problem.link} target="_blank" rel="noreferrer">
            <BrandIcon brand="github" size={13} /> Get the GitHub CLI <ExternalLink size={12} />
          </a>
        )}
        <Button variant="app" className="secondary" onClick={onRetry}>
          Check again
        </Button>
      </div>
    </div>
  )
}

function PrList({
  cwd,
  gh,
  branch,
  refreshKey,
  onOpen,
  onCreate,
}: {
  cwd: string
  gh: Extract<GithubStatus, { state: 'ready' }>
  branch: string | undefined
  refreshKey: unknown
  onOpen(number: number): void
  onCreate(): void
}) {
  const hostKey = useHostKey()
  const [filter, setFilter] = useState<PrFilter>('open')
  const [bump, setBump] = useState(0)
  const key = `${hostKey}:${cwd}:${refreshKey}:${bump}`
  const list = usePolled(
    async () => ({ filter, ...(await hostRequest(hostKey, 'git.pr.list', { cwd, filter })) }),
    `${key}:${filter}`,
    30_000,
  )
  const current = usePolled(() => hostRequest(hostKey, 'git.pr.get', { cwd }), key, 30_000)
  const items = list.data?.filter === filter ? list.data.items : undefined
  const mine = current.data
  const onDefault = !branch || branch === gh.defaultBranch

  return (
    <div className="pr-pane">
      <div className="pr-toolbar">
        <div className="pr-filters" role="tablist" aria-label="Pull request filter">
          {PR_FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <Button
          variant="app"
          className="icon-btn small"
          aria-label="Refresh pull requests"
          title="Refresh"
          onClick={() => setBump((b) => b + 1)}
        >
          <RotateCw size={13} />
        </Button>
        <button
          className="pr-new"
          onClick={onCreate}
          disabled={onDefault || Boolean(mine)}
          title={
            onDefault
              ? 'Switch to a branch to open a pull request from it'
              : mine
                ? `${branch} already has #${mine.number}`
                : `New pull request from ${branch}`
          }
        >
          <Plus size={13} /> New
        </button>
      </div>
      <div className="git-scroll pr-list">
        {mine ? (
          <>
            <div className="pr-group-label">This branch</div>
            <PrRow
              pr={items?.find((i) => i.number === mine.number) ?? summaryOf(mine)}
              current
              onOpen={onOpen}
            />
          </>
        ) : (
          !onDefault &&
          !current.loading && (
            <div className="pr-cta">
              <GitBranch size={15} />
              <span>
                No pull request for <code>{branch}</code> yet
              </span>
              <Button variant="app" className="secondary" onClick={onCreate}>
                Create pull request
              </Button>
            </div>
          )
        )}
        <div className="pr-group-label">
          {PR_FILTERS.find((f) => f.id === filter)?.label}
          {items && <span className="muted"> · {items.length}</span>}
        </div>
        {list.error && <div className="composer-error">{list.error}</div>}
        {!items && !list.error && <div className="muted pr-loading">Loading…</div>}
        {items?.length === 0 && (
          <div className="muted pr-loading">
            {filter === 'review'
              ? 'Nobody is waiting on your review.'
              : filter === 'mine'
                ? 'You have no open pull requests here.'
                : `No ${filter} pull requests.`}
          </div>
        )}
        {items
          ?.filter((pr) => pr.number !== mine?.number)
          .map((pr) => (
            <PrRow key={pr.number} pr={pr} onOpen={onOpen} />
          ))}
      </div>
      <div className="pr-foot muted">
        Signed in as <strong>{gh.login}</strong> ·{' '}
        <a href={`${gh.url}/pulls`} target="_blank" rel="noreferrer">
          <BrandIcon brand="github" size={11} /> {gh.repo} <ExternalLink size={11} />
        </a>
      </div>
    </div>
  )
}

function summaryOf(pr: PullRequest): PullRequestSummary {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    author: '',
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    updatedAt: pr.createdAt,
    reviewDecision: pr.reviewDecision,
    added: pr.files.reduce((n, f) => n + f.added, 0),
    removed: pr.files.reduce((n, f) => n + f.removed, 0),
    ...checksSummary(pr.checks),
  }
}

function PrRow({
  pr,
  current,
  onOpen,
}: {
  pr: PullRequestSummary
  current?: boolean
  onOpen(n: number): void
}) {
  const kind = prStateKind(pr)
  return (
    <button className={`pr-row ${current ? 'current' : ''}`} onClick={() => onOpen(pr.number)}>
      <PrStateIcon kind={kind} />
      <span className="pr-row-main">
        <span className="pr-row-title">{pr.title}</span>
        <span className="pr-row-meta">
          #{pr.number}
          {pr.author && ` · ${pr.author}`}
          {pr.updatedAt !== undefined &&
            ` · ${current && !pr.author ? 'opened' : 'updated'} ${agoLabel(pr.updatedAt)}`}
          {kind === 'draft' && ' · draft'}
        </span>
        <span className="pr-row-branch">
          <code>{pr.headBranch}</code>
          <ArrowRight size={11} />
          <code>{pr.baseBranch}</code>
          {pr.fromFork && <span className="pr-fork">fork</span>}
        </span>
      </span>
      <span className="pr-row-side">
        {pr.checks && (
          <span className="pr-checks" title={checksLabel(pr)}>
            {CHECK_ICON[pr.checks]}
          </span>
        )}
        <ReviewBadge decision={pr.reviewDecision} />
        {(pr.added !== undefined || pr.removed !== undefined) && (
          <span className="stat">
            <span className="add">+{pr.added ?? 0}</span>{' '}
            <span className="del">−{pr.removed ?? 0}</span>
          </span>
        )}
      </span>
    </button>
  )
}

/** What to know before merging, one line each: green is fine, amber is a heads up, red blocks. */
function Readiness({
  items,
  busy,
  onPush,
  onAgent,
}: {
  items: ReadinessItem[]
  busy: boolean
  onPush(): void
  /** Hands the problem to the session's agent; absent when there is no session. */
  onAgent?(): void
}) {
  if (items.length === 0) return null
  return (
    <ul className="pr-ready" aria-label="Merge readiness">
      {items.map((item, i) => (
        <li key={i} className={`pr-ready-item ${item.level}`}>
          {item.level === 'ok' ? (
            <CircleCheck size={13} className="ok" />
          ) : item.level === 'bad' ? (
            <CircleX size={13} className="bad" />
          ) : (
            <CircleDot size={13} className="wait" />
          )}
          <span>{item.text}</span>
          {item.fix === 'agent' && onAgent && (
            <Button variant="app" className="link-btn" disabled={busy} onClick={onAgent}>
              Fix with agent
            </Button>
          )}
          {item.fix === 'push' && (
            <Button variant="app" className="link-btn" disabled={busy} onClick={onPush}>
              Push
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

function PrDetailView({
  cwd,
  number,
  gh,
  refreshKey,
  onBack,
  onChanged,
  sessionId,
  branch,
  ahead,
  uncommitted,
  isWorktree,
}: {
  cwd: string
  number: number
  gh: Extract<GithubStatus, { state: 'ready' }>
  refreshKey: unknown
  onBack(): void
  onChanged(): void
  sessionId?: string
  /** The branch the folder is on now. */
  branch?: string
  ahead?: number
  uncommitted?: number
  isWorktree?: boolean
}) {
  const hostKey = useHostKey()
  const navigate = useNavigate()
  const [bump, setBump] = useState(0)
  const pr = usePolled(
    () => hostRequest(hostKey, 'git.pr.view', { cwd, number }),
    `${hostKey}:${cwd}:${number}:${refreshKey}:${bump}`,
    20_000,
  )
  const [busy, setBusy] = useState<string>()
  const [notice, setNotice] = useState<{ text: string; path?: string }>()
  const [error, setError] = useState<string>()
  const [comment, setComment] = useState('')
  const [merging, setMerging] = useState(false)
  const [method, setMethod] = useState(gh.mergeMethods[0] ?? 'merge')
  const [deleteBranch, setDeleteBranch] = useState(gh.deleteBranchOnMerge)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [cleanupAfter, setCleanupAfter] = useState(true)
  const [tidy, setTidy] = useState({ updateBase: true, removeWorktree: true, deleteBranch: true })

  const run = async (label: string, work: () => Promise<{ message?: string; path?: string }>) => {
    setBusy(label)
    setError(undefined)
    setNotice(undefined)
    try {
      const res = await work()
      if (res.message) setNotice({ text: res.message, path: res.path })
      setBump((b) => b + 1)
      onChanged()
      // The session's row in the sidebar shows this pull request's state.
      void refreshSessionPr(hostKey, cwd)
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    } finally {
      setBusy(undefined)
    }
  }
  const act = (label: string, action: Parameters<typeof hostRequest<'git.pr.act'>>[2]['do']) =>
    run(label, () => hostRequest(hostKey, 'git.pr.act', { cwd, number, do: action }))

  const header = (
    <div className="pr-detail-bar">
      <Button
        variant="app"
        className="icon-btn small"
        aria-label="Back to pull requests"
        onClick={onBack}
      >
        <ArrowLeft size={14} />
      </Button>
      <span className="muted">Pull requests</span>
      <span className="spacer" />
      <Button
        variant="app"
        className="icon-btn small"
        aria-label="Refresh pull request"
        title="Refresh"
        onClick={() => setBump((b) => b + 1)}
      >
        <RotateCw size={13} />
      </Button>
      {pr.data && (
        <a
          className="icon-btn small"
          href={pr.data.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open on GitHub"
          title="Open on GitHub"
        >
          <BrandIcon brand="github" size={13} />
        </a>
      )}
    </div>
  )
  if (!pr.data) {
    return (
      <div className="pr-pane">
        {header}
        <div className="git-empty muted">{pr.error ?? 'Loading…'}</div>
      </div>
    )
  }
  const d = pr.data
  const kind = prStateKind(d)
  const canWrite = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(gh.permission ?? '')
  const isAuthor = d.author === gh.login
  const canManage = canWrite || isAuthor
  const blocker = mergeBlocker(d)
  // What only this folder knows matters only while it is on the pull request's branch.
  const onBranch = branch !== undefined && branch === d.headBranch
  const local: MergeLocalState | undefined = onBranch
    ? { unpushed: ahead ?? 0, uncommitted: uncommitted ?? 0 }
    : undefined
  const readiness = mergeReadiness(d, local)
  // Conflicts and a branch behind its base are the agent's to sort out, in this folder.
  const fixWithAgent = () =>
    run('agent', async () => {
      if (!sessionId) throw new Error('Open this from a session to hand it to its agent')
      await prompt(sessionId, syncPrompt(d))
      return { message: 'Sent to the agent' }
    })
  const push = () =>
    run('push', async () => {
      await hostRequest(hostKey, 'git.push', { cwd })
      return { message: 'Pushed' }
    })
  // After a merge: bring the base branch up to date and remove what the branch left behind.
  const cleanup = (what: { updateBase: boolean; removeWorktree: boolean; deleteBranch: boolean }) =>
    run('cleanup', async () => {
      const res = await hostRequest(hostKey, 'git.pr.cleanup', { cwd, number, sessionId, ...what })
      // The session's folder is gone; there is nothing left here to show.
      if (res.steps.some((s) => s.step === 'remove-worktree' && s.status === 'done'))
        void navigate({ to: '/' })
      return { message: cleanupLines(res.steps).join(' · ') }
    })
  const counts = checkCounts(d.checks)
  const filesAdded = d.added ?? d.files.reduce((n, f) => n + f.added, 0)
  const filesRemoved = d.removed ?? d.files.reduce((n, f) => n + f.removed, 0)

  return (
    <div className="pr-pane">
      {header}
      <div className="git-scroll pr">
        <div className="pr-head">
          <span className={`state ${kind}`}>
            <PrStateIcon kind={kind} size={13} /> {PR_STATE_LABEL[kind]}
          </span>
          <ReviewBadge decision={d.reviewDecision} />
          <span className="muted">#{d.number}</span>
        </div>
        <h3>{d.title}</h3>
        <div className="pr-meta muted">
          <strong>{d.author}</strong>
          {d.state === 'MERGED' && d.mergedAt
            ? ` merged ${agoLabel(d.mergedAt)}${d.mergedBy && d.mergedBy !== d.author ? ` by ${d.mergedBy}` : ''}`
            : d.createdAt
              ? ` opened ${agoLabel(d.createdAt)}`
              : ''}
          {d.updatedAt ? ` · updated ${agoLabel(d.updatedAt)}` : ''}
        </div>
        <div className="branches">
          <code>{d.headBranch}</code> <ArrowRight size={13} /> <code>{d.baseBranch}</code>
          {d.fromFork && <span className="pr-fork">fork</span>}
        </div>
        {d.body.trim() ? (
          <div className="pr-body">
            <Markdown text={d.body} />
          </div>
        ) : (
          <div className="muted">No description.</div>
        )}

        {d.checks.length > 0 && (
          <section className="pr-section">
            <div className="section-title">
              Checks
              <span className="muted">
                {counts.failed
                  ? `${counts.failed} failing`
                  : counts.pending
                    ? `${counts.pending} running`
                    : `${counts.passed} of ${counts.total} passed`}
              </span>
            </div>
            {d.checks.map((c, i) => (
              <div key={`${c.name}-${i}`} className="check-row">
                {CHECK_ICON[c.state]}
                <span className="check-name">
                  {c.name}
                  {c.workflow && <span className="muted"> · {c.workflow}</span>}
                </span>
                {c.url && (
                  <a href={c.url} target="_blank" rel="noreferrer" aria-label={`Open ${c.name}`}>
                    <ExternalLink size={12} />
                  </a>
                )}
              </div>
            ))}
          </section>
        )}

        <section className="pr-section">
          <div className="section-title">
            Conversation <span className="muted">{d.timeline.length || ''}</span>
          </div>
          {d.timeline.length === 0 && (
            <div className="muted small">No reviews or comments yet.</div>
          )}
          {d.timeline.map((t, i) => (
            <div key={i} className={`pr-event ${t.kind} ${t.state?.toLowerCase() ?? ''}`}>
              <div className="pr-event-head">
                <span className="pr-avatar" aria-hidden>
                  {t.author.slice(0, 1).toUpperCase()}
                </span>
                <strong>{t.author}</strong>
                <span className="muted">
                  {t.kind === 'review' ? reviewStateLabel(t.state) : 'commented'}
                  {t.at ? ` · ${agoLabel(t.at)}` : ''}
                </span>
              </div>
              <EventBody body={t.body} />
            </div>
          ))}
          <div className="pr-comment">
            <Textarea
              className="field"
              rows={2}
              placeholder="Add a comment"
              aria-label="Comment on the pull request"
              value={comment}
              disabled={Boolean(busy)}
              onChange={(e) => setComment(e.target.value)}
            />
            <Button
              variant="app"
              className="secondary"
              disabled={!comment.trim() || Boolean(busy)}
              onClick={() =>
                void act('comment', { action: 'comment', body: comment }).then(
                  (ok) => ok && setComment(''),
                )
              }
            >
              {busy === 'comment' ? 'Sending…' : 'Comment'}
            </Button>
          </div>
        </section>

        {d.files.length > 0 && (
          <section className="pr-section">
            <div className="section-title">
              Files changed · {d.files.length}
              <span className="stat">
                <span className="add">+{filesAdded}</span>{' '}
                <span className="del">−{filesRemoved}</span>
              </span>
            </div>
            {d.files.map((f) => (
              <a
                key={f.path}
                className="commit-file pr-file"
                href={`${d.url}/files`}
                target="_blank"
                rel="noreferrer"
                title="See the diff on GitHub"
              >
                <span className="file-path">{f.path}</span>
                <span className="stat">
                  <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
                </span>
              </a>
            ))}
          </section>
        )}
      </div>

      <div className="git-footer">
        {notice && (
          <div className="pr-notice" role="status">
            <Check size={13} /> {notice.text}
            {notice.path && (
              <Button
                variant="app"
                className="link-btn"
                onClick={() =>
                  void navigate({
                    to: '/',
                    search: { project: notice.path, host: hostKey, compose: true },
                  })
                }
              >
                Start a session there
              </Button>
            )}
          </div>
        )}
        {error && (
          <div className="composer-error" role="alert">
            {error}
          </div>
        )}
        {d.state === 'MERGED' && onBranch && (
          <div className="pr-merge">
            <div className="pr-merge-title">Clean up after the merge</div>
            <label className="check-line">
              <Checkbox
                checked={tidy.updateBase}
                onCheckedChange={(checked) => setTidy({ ...tidy, updateBase: checked === true })}
              />
              Bring <code>{d.baseBranch}</code> up to date in the main checkout
            </label>
            {isWorktree && (
              <label className="check-line">
                <Checkbox
                  checked={tidy.removeWorktree}
                  onCheckedChange={(checked) =>
                    setTidy({ ...tidy, removeWorktree: checked === true })
                  }
                />
                Remove this worktree (its agent stops)
              </label>
            )}
            <label className="check-line">
              <Checkbox
                checked={tidy.deleteBranch}
                onCheckedChange={(checked) => setTidy({ ...tidy, deleteBranch: checked === true })}
              />
              Delete the local branch <code>{d.headBranch}</code>
            </label>
            <div className="muted small">
              Anything this folder has that the pull request does not (extra commits, uncommitted
              files) is kept.
            </div>
            <div className="git-actions">
              <Button
                variant="app"
                className="primary"
                disabled={
                  Boolean(busy) || !(tidy.updateBase || tidy.removeWorktree || tidy.deleteBranch)
                }
                onClick={() =>
                  void cleanup({
                    ...tidy,
                    removeWorktree: tidy.removeWorktree && isWorktree === true,
                  })
                }
              >
                {busy === 'cleanup' ? 'Cleaning up…' : 'Clean up'}
              </Button>
            </div>
          </div>
        )}
        {d.state === 'OPEN' && canWrite && merging ? (
          <div className="pr-merge">
            <div className="pr-merge-title">
              Merge #{d.number} into {d.baseBranch}?
            </div>
            {gh.mergeMethods.length > 1 && (
              <div className="pr-methods" role="radiogroup" aria-label="Merge method">
                {gh.mergeMethods.map((m) => (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={method === m}
                    onClick={() => setMethod(m)}
                  >
                    {MERGE_METHOD_LABEL[m]}
                  </button>
                ))}
              </div>
            )}
            {!d.fromFork && (
              <label className="check-line">
                <Checkbox
                  checked={deleteBranch}
                  onCheckedChange={(checked) => setDeleteBranch(checked === true)}
                />
                Delete <code>{d.headBranch}</code> on GitHub afterwards
              </label>
            )}
            <Readiness
              items={readiness}
              busy={Boolean(busy)}
              onPush={() => void push()}
              onAgent={sessionId ? () => void fixWithAgent() : undefined}
            />
            {onBranch && (
              <label className="check-line">
                <Checkbox
                  checked={cleanupAfter}
                  onCheckedChange={(checked) => setCleanupAfter(checked === true)}
                />
                {isWorktree
                  ? `Then remove this worktree and update ${d.baseBranch}`
                  : `Then switch to ${d.baseBranch} and delete this branch`}
              </label>
            )}
            <div className="git-actions">
              <Button
                variant="app"
                className="secondary"
                disabled={Boolean(busy)}
                onClick={() => setMerging(false)}
              >
                Cancel
              </Button>
              <button
                className="primary danger-ok"
                disabled={Boolean(busy)}
                onClick={() =>
                  void (async () => {
                    const merged = await act('merge', {
                      action: 'merge',
                      method,
                      headOid: d.headOid,
                      deleteBranch: !d.fromFork && deleteBranch,
                    })
                    if (!merged) return
                    setMerging(false)
                    if (cleanupAfter && onBranch)
                      await cleanup({
                        updateBase: true,
                        removeWorktree: isWorktree === true,
                        deleteBranch: true,
                      })
                  })()
                }
              >
                {busy === 'merge'
                  ? 'Merging…'
                  : `Confirm ${MERGE_METHOD_LABEL[method].toLowerCase()}`}
              </button>
            </div>
          </div>
        ) : (
          <>
            {d.state === 'OPEN' && canWrite && (
              <Readiness
                items={readiness}
                busy={Boolean(busy)}
                onPush={() => void push()}
                onAgent={sessionId ? () => void fixWithAgent() : undefined}
              />
            )}
            <div className="git-actions pr-actions">
              {d.state === 'OPEN' && canWrite && (
                <Button
                  variant="app"
                  className="primary"
                  disabled={Boolean(busy) || Boolean(blocker) || gh.mergeMethods.length === 0}
                  onClick={() => setMerging(true)}
                >
                  <GitMerge size={13} /> Merge…
                </Button>
              )}
              {d.state !== 'OPEN' && (
                <a className="primary as-button" href={d.url} target="_blank" rel="noreferrer">
                  <BrandIcon brand="github" size={13} /> Open on GitHub
                </a>
              )}
              <div className="pr-checkout">
                <Button
                  variant="app"
                  className="secondary"
                  aria-expanded={checkoutOpen}
                  disabled={Boolean(busy) || d.state === 'MERGED'}
                  onClick={() => setCheckoutOpen((o) => !o)}
                >
                  {busy === 'checkout' ? 'Checking out…' : 'Check out'}
                </Button>
                {checkoutOpen && (
                  <div className="pr-menu" role="menu">
                    <button
                      role="menuitem"
                      onClick={async () => {
                        setCheckoutOpen(false)
                        if (
                          !(await confirmDialog(
                            `Switch this folder to ${d.headBranch}? Uncommitted changes stay in the folder; git refuses if they clash.`,
                            'Switch',
                          ))
                        )
                          return
                        void run('checkout', async () => {
                          const r = await hostRequest(hostKey, 'git.pr.checkout', { cwd, number })
                          return { message: `Checked out ${r.branch} here` }
                        })
                      }}
                    >
                      <GitBranch size={14} /> Here, switching this folder
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setCheckoutOpen(false)
                        void run('checkout', async () => {
                          const r = await hostRequest(hostKey, 'git.pr.checkout', {
                            cwd,
                            number,
                            worktree: true,
                          })
                          return { message: `${r.branch} is in a worktree`, path: r.path }
                        })
                      }}
                    >
                      <FolderGit2 size={14} /> Into a new worktree
                    </button>
                  </div>
                )}
              </div>
              {d.state === 'OPEN' && canManage && d.isDraft && (
                <Button
                  variant="app"
                  className="secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void act('ready', { action: 'ready' })}
                >
                  Ready for review
                </Button>
              )}
              {d.state === 'OPEN' && canManage && !d.isDraft && (
                <Button
                  variant="app"
                  className="secondary"
                  disabled={Boolean(busy)}
                  title="Convert to draft"
                  onClick={() => void act('draft', { action: 'draft' })}
                >
                  To draft
                </Button>
              )}
              {d.state === 'OPEN' && canManage && (
                <Button
                  variant="app"
                  className="secondary danger-text"
                  disabled={Boolean(busy)}
                  onClick={async () => {
                    if (!(await confirmDialog(`Close #${d.number} without merging?`, 'Close')))
                      return
                    void act('close', { action: 'close' })
                  }}
                >
                  Close
                </Button>
              )}
              {d.state === 'CLOSED' && canManage && (
                <Button
                  variant="app"
                  className="secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void act('reopen', { action: 'reopen' })}
                >
                  Reopen
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function CreatePr({
  cwd,
  branch,
  log,
  onCreated,
  onCancel,
  sessionId,
  instanceId,
  defaultBase,
  needsPush,
}: {
  cwd: string
  branch: string | undefined
  log: GitLog | undefined
  onCreated(number?: number): void
  onCancel(): void
  sessionId?: string
  instanceId?: string
  defaultBase?: string
  needsPush: boolean
}) {
  const hostKey = useHostKey()
  const commits = useMemo(() => (log ? [...log.unpushed, ...log.pushed] : []), [log])
  const prefill = useMemo(() => prDraftFromCommits(commits, branch), [commits, branch])
  const [title, setTitle] = useState(prefill.title)
  const [body, setBody] = useState(prefill.body)
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [base, setBase] = useState(defaultBase ?? 'main')
  const [generating, setGenerating] = useState(false)
  const branches = usePolled(
    () => hostRequest(hostKey, 'git.branches', { cwd }),
    `${hostKey}:${cwd}`,
    0,
  )
  const bases = (branches.data ?? []).map((b) => b.name).filter((n) => n !== branch)

  const create = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const { url } = await hostRequest(hostKey, 'git.pr.create', {
        cwd,
        title: title.trim(),
        body,
        draft,
        base: base.trim(),
      })
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1])
      onCreated(Number.isFinite(number) ? number : undefined)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const nothing = commits.length === 0
  return (
    <div className="pr-pane">
      <div className="pr-detail-bar">
        <Button
          variant="app"
          className="icon-btn small"
          aria-label="Back to pull requests"
          onClick={onCancel}
        >
          <ArrowLeft size={14} />
        </Button>
        <span className="muted">New pull request</span>
      </div>
      <div className="git-scroll pr">
        <div className="branches">
          <code>{branch ?? 'HEAD'}</code> <ArrowRight size={13} /> <code>{base || '…'}</code>
        </div>
        {nothing ? (
          <div className="muted">Commit some changes on this branch first.</div>
        ) : (
          <>
            <label className="git-field-label">
              Base branch
              <Input
                className="field"
                aria-label="Base branch"
                list="pr-base-branches"
                value={base}
                disabled={busy || generating}
                onChange={(e) => setBase(e.target.value)}
              />
              <datalist id="pr-base-branches">
                {bases.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </label>
            <GenerateGitText
              sessionId={sessionId}
              cwd={cwd}
              preferredInstanceId={instanceId}
              kind="pr"
              base={base}
              disabled={busy || !base.trim() || branch === base.trim()}
              onBusy={setGenerating}
              onGenerated={(generated) => {
                setTitle(generated.title ?? '')
                setBody(generated.body ?? '')
              }}
            />
            <p className="muted small">
              Filled in from {commits.length === 1 ? 'the commit' : `${commits.length} commits`}; an
              agent can write it from the changes instead.
            </p>
            <Input
              className="field"
              placeholder="Title"
              aria-label="Pull request title"
              readOnly={generating || busy}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Textarea
              className="field"
              placeholder="Describe the change (Markdown)"
              aria-label="Pull request description"
              readOnly={generating || busy}
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <label className="check-line">
              <Checkbox checked={draft} onCheckedChange={(checked) => setDraft(checked === true)} />
              Open as draft
            </label>
            <div className="muted small">
              {needsPush
                ? `Pushes ${branch ?? 'this branch'} to GitHub first.`
                : `${branch ?? 'This branch'} is already on GitHub.`}
            </div>
          </>
        )}
        {error && <div className="composer-error">{error}</div>}
      </div>
      <div className="git-footer">
        <div className="git-actions">
          <Button variant="app" className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="app"
            className="primary"
            disabled={
              nothing ||
              busy ||
              generating ||
              !base.trim() ||
              branch === base.trim() ||
              title.trim().length === 0
            }
            onClick={() => void create()}
          >
            {busy
              ? 'Creating…'
              : `${needsPush ? 'Push & create' : 'Create'} ${draft ? 'draft ' : ''}pull request`}
          </Button>
        </div>
      </div>
    </div>
  )
}

function EventBody({ body }: { body: string }) {
  const text = useMemo(() => commentText(body), [body])
  const long = text.length > 600 || text.split('\n').length > 12
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <>
      <div className={`pr-event-body ${long && !open ? 'clamped' : ''}`}>
        <Markdown text={text} />
      </div>
      {long && (
        <button className="pr-more" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  )
}
