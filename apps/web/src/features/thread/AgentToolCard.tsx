import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowUpRight,
  Ban,
  Bot,
  Check,
  ChevronRight,
  CornerLeftUp,
  FolderGit2,
  GitBranch,
  Hand,
  List,
  Loader2,
  MessageSquare,
  Square,
  X,
} from 'lucide-react'
import {
  agentDisplayName,
  agentToolView,
  childActivity,
  childPhase,
  childSessions,
  CHILD_PHASE_LABEL,
  formatDuration,
  preview,
  toolDuration,
  type AgentToolView,
  type ChildPhase,
  type SessionView,
  type Tool,
} from '@beddcode/client-runtime'
import { useHostStore } from '../../stores/host.ts'
import { folderName } from '../../ui/format.ts'

const NO_SESSIONS: Record<string, SessionView> = {}

/** Every session of the host, to follow children live. */
function useHostSessions(hostKey: string | undefined): Record<string, SessionView> {
  return useHostStore((s) =>
    hostKey ? (s.runtimes[hostKey]?.replica.sessions ?? NO_SESSIONS) : NO_SESSIONS,
  )
}

/** The host's own names for its agents ("Claude", "Codex", "Grok"). */
function useAgentLabels(hostKey: string | undefined): Record<string, string> {
  const providers = useHostStore((s) => (hostKey ? s.runtimes[hostKey]?.providers : undefined))
  const labels: Record<string, string> = {}
  for (const p of providers ?? []) labels[p.id] = p.label
  return labels
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const LIVE: ChildPhase[] = ['starting', 'running', 'needs-you']

/** The agent's initials in a small square, like the session's own agent chip. */
export function AgentAvatar({ agent, label }: { agent?: string; label: string }) {
  const initials = label
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <span className="avatar agent-avatar" data-agent={agent} aria-hidden>
      {initials}
    </span>
  )
}

function PhaseIcon({ phase }: { phase: ChildPhase }) {
  switch (phase) {
    case 'starting':
    case 'running':
      return <Loader2 size={12} className="spin" />
    case 'needs-you':
      return <Hand size={12} />
    case 'done':
      return <Check size={12} />
    case 'failed':
      return <X size={12} />
    case 'stopped':
      return <Ban size={12} />
  }
}

/** A child's status as a small pill: icon, words, and how long it has run. */
export function PhasePill({ phase, elapsed }: { phase: ChildPhase; elapsed?: number }) {
  return (
    <span className={`agent-phase ${phase}`} role="status">
      <PhaseIcon phase={phase} />
      {CHILD_PHASE_LABEL[phase]}
      {elapsed !== undefined && <span className="agent-phase-time">{formatDuration(elapsed)}</span>}
    </span>
  )
}

function OpenSession({ id, label = 'Open session' }: { id: string; label?: string }) {
  return (
    <Link
      to="/session/$sessionId"
      params={{ sessionId: id }}
      className="agent-open"
      title="Open this session"
    >
      {label} <ArrowUpRight size={12} />
    </Link>
  )
}

/** The card's title as the button that folds and unfolds it. */
function CardToggle({
  open,
  onToggle,
  children,
}: {
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <button type="button" className="agent-card-toggle" aria-expanded={open} onClick={onToggle}>
      <ChevronRight size={12} className="agent-card-chevron" />
      {children}
    </button>
  )
}

/** A long text behind a one-line preview, opened on click. */
function Fold({
  label,
  text,
  defaultOpen = false,
}: {
  label: string
  text: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`agent-fold ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="agent-fold-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight size={12} className="agent-fold-chevron" />
        <span className="agent-fold-label">{label}</span>
        {!open && <span className="agent-fold-preview">{preview(text, 160)}</span>}
      </button>
      {open && <pre className="agent-fold-body">{text}</pre>}
    </div>
  )
}

/**
 * One call to BeddCode's agent tools, as a card when it concerns one child session (start, wait,
 * read, check) and as a single line otherwise (message, stop, lists).
 */
export function AgentToolCard({
  tool,
  parentId,
  hostKey,
}: {
  tool: Tool
  parentId?: string
  hostKey?: string
}) {
  const sessions = useHostSessions(hostKey)
  const labels = useAgentLabels(hostKey)
  const view = agentToolView(tool, { parentId, sessions })
  const live =
    tool.status === 'running' || (view?.child !== undefined && LIVE.includes(view.child.phase))
  const now = useNow(live)
  if (!view) return null
  switch (view.name) {
    case 'start_session':
      return <StartCard view={view} tool={tool} labels={labels} now={now} />
    case 'wait_for':
    case 'read_transcript':
      return <ResultCard view={view} tool={tool} labels={labels} now={now} />
    default:
      return <AgentToolRow view={view} tool={tool} labels={labels} now={now} />
  }
}

interface CardProps {
  view: AgentToolView
  tool: Tool
  labels: Record<string, string>
  now: number
}

function childName(view: AgentToolView, labels: Record<string, string>) {
  return agentDisplayName(view.child?.agent, labels)
}

/** Where the child works when it is not simply the parent's folder: a worktree and its branch. */
function WhereLine({ view }: { view: AgentToolView }) {
  const child = view.child
  if (!child?.worktree && !child?.branch) return null
  return (
    <div className="agent-where" title={child.folder}>
      {child.worktree && (
        <>
          <FolderGit2 size={12} />
          <span>Worktree{child.folder ? ` · ${folderName(child.folder)}` : ''}</span>
        </>
      )}
      {child.branch && (
        <>
          <GitBranch size={12} />
          <span className="mono">{child.branch}</span>
        </>
      )}
    </div>
  )
}

/** start_session: who was started, on what, where, and how it is doing now. */
function StartCard({ view, tool, labels, now }: CardProps) {
  const child = view.child
  const name = childName(view, labels)
  const phase = child?.phase ?? 'starting'
  const elapsed =
    child?.startedAt !== undefined
      ? Math.max(0, (child.endedAt ?? now) - child.startedAt)
      : toolDuration(tool, now)
  const liveNow = LIVE.includes(phase)
  // Open while there is something to watch or fix; a finished card folds to one line.
  const [open, setOpen] = useState(liveNow || Boolean(view.error))
  return (
    <div className={`agent-card ${phase} ${view.error ? 'error' : ''}`}>
      <div className="agent-card-head">
        <CardToggle open={open} onToggle={() => setOpen((o) => !o)}>
          <AgentAvatar agent={child?.agent} label={name} />
          <span className="agent-card-title">
            <span className="agent-verb">{view.verb}</span> <strong>{name}</strong>
            {child?.title && <span className="agent-card-name"> · {child.title}</span>}
          </span>
        </CardToggle>
        {view.error ? (
          <span className="agent-phase failed">
            <X size={12} /> Not started
          </span>
        ) : (
          <PhasePill phase={phase} elapsed={elapsed} />
        )}
        {child?.id && child.known && <OpenSession id={child.id} label="Open" />}
      </div>
      {open && view.prompt && <p className="agent-task">{preview(view.prompt, 400)}</p>}
      {open && <WhereLine view={view} />}
      {liveNow && child?.activity && (
        <div className="agent-activity">
          <span className="agent-activity-dot" aria-hidden />
          <span className="mono">{child.activity}</span>
        </div>
      )}
      {view.error && <p className="agent-error">{view.error}</p>}
      {open && !liveNow && child?.reply && <Fold label="Result" text={child.reply} />}
    </div>
  )
}

/** wait_for and read_transcript: what came back, folded, with the child's live state beside it. */
function ResultCard({ view, tool, labels, now }: CardProps) {
  const child = view.child
  const name = childName(view, labels)
  const ms = toolDuration(tool, now)
  const phase: ChildPhase = view.pending
    ? (child?.phase ?? 'running')
    : view.error
      ? 'failed'
      : (child?.phase ?? 'done')
  const body = view.name === 'wait_for' ? view.reply : view.transcript
  const [open, setOpen] = useState(Boolean(view.pending || view.error))
  // The start call's card already shows this reply; a second copy would only repeat it.
  if (view.name === 'wait_for' && !view.pending && !view.error && body && body === child?.reply) {
    return <AgentToolRow view={view} tool={tool} labels={labels} now={now} />
  }
  return (
    <div className={`agent-card compact ${view.error ? 'error' : ''}`}>
      <div className="agent-card-head">
        <CardToggle open={open} onToggle={() => setOpen((o) => !o)}>
          {view.name === 'wait_for' && view.pending ? (
            <Loader2 size={13} className="spin agent-card-icon" />
          ) : (
            <AgentAvatar agent={child?.agent} label={name} />
          )}
          <span className="agent-card-title">
            <span className="agent-verb">{view.verb}</span> <strong>{name}</strong>
            {child?.title && <span className="agent-card-name"> · {child.title}</span>}
          </span>
        </CardToggle>
        {ms !== undefined && <span className="tcall-time">{formatDuration(ms)}</span>}
        <PhasePill phase={phase} />
        {child?.id && child.known && <OpenSession id={child.id} label="Open" />}
      </div>
      {view.pending && child?.activity && (
        <div className="agent-activity">
          <span className="agent-activity-dot" aria-hidden />
          <span className="mono">{child.activity}</span>
        </div>
      )}
      {open && view.stillWorking && (
        <p className="agent-note">
          {phase === 'needs-you'
            ? 'It was waiting for your approval then.'
            : 'It was still working; the agent checks again.'}
        </p>
      )}
      {view.error && <p className="agent-error">{view.error}</p>}
      {open && body && (
        <Fold label={view.name === 'wait_for' ? 'Reply' : 'Conversation'} text={body} />
      )}
      {open && !view.pending && !body && !view.error && <p className="agent-note">No reply yet.</p>}
    </div>
  )
}

const ROW_ICONS = {
  send_message: MessageSquare,
  stop: Square,
  get_status: Bot,
  list_agents: List,
  list_children: List,
} as const

/** send_message, stop, get_status and the lists: one line, with a link to the child. */
function AgentToolRow({ view, tool, labels, now }: CardProps) {
  const Icon = ROW_ICONS[view.name as keyof typeof ROW_ICONS] ?? Bot
  const child = view.child
  const ms = toolDuration(tool, now)
  const what =
    view.name === 'list_agents'
      ? view.listed?.map((l) => l.label).join(', ')
      : view.name === 'list_children'
        ? view.listed?.length
          ? `${view.listed.length} · ${view.listed.map((l) => `${l.label} (${l.detail})`).join(', ')}`
          : view.pending
            ? undefined
            : 'none yet'
        : view.prompt
          ? `“${preview(view.prompt, 120)}”`
          : undefined
  return (
    <div className={`agent-row ${tool.status} ${view.error ? 'error' : ''}`}>
      <Icon size={13} className="agent-row-icon" />
      <span className="agent-row-text" title={view.error ?? view.prompt}>
        <span className="agent-verb">{view.verb}</span>
        {child && (
          <>
            {' '}
            <strong>{childName(view, labels)}</strong>
            {child.title && <span className="agent-card-name"> · {child.title}</span>}
          </>
        )}
        {what && <span className="agent-row-what"> {what}</span>}
        {view.error && <span className="agent-row-error"> — {preview(view.error, 120)}</span>}
      </span>
      {view.name === 'get_status' && child && !view.pending && <PhasePill phase={child.phase} />}
      {ms !== undefined && <span className="tcall-time">{formatDuration(ms)}</span>}
      {view.pending ? (
        <Loader2 size={12} className="spin agent-row-state" />
      ) : view.error ? (
        <X size={12} className="agent-row-state failed" />
      ) : (
        <Check size={12} className="agent-row-state ok" />
      )}
      {child?.id && child.known && <OpenSession id={child.id} label="Open" />}
    </div>
  )
}

/** At the top of a session another session's agent started: who started it, and a way back. */
export function StartedByBanner({ session, hostKey }: { session: SessionView; hostKey: string }) {
  const sessions = useHostSessions(hostKey)
  const labels = useAgentLabels(hostKey)
  if (!session.parent) return null
  const parent = sessions[session.parent.sessionId]
  const label = agentDisplayName(parent?.instanceId, labels)
  return (
    <div
      className="started-by"
      role="note"
      title="Its agent can read this conversation and send it messages; you answer its approvals here."
    >
      <CornerLeftUp size={13} className="started-by-icon" />
      <span className="started-by-text">
        Started by
        {parent ? (
          <>
            <AgentAvatar agent={parent.instanceId} label={label} /> <strong>{label}</strong> in
            <Link
              to="/session/$sessionId"
              params={{ sessionId: parent.id }}
              className="started-by-link"
            >
              {parent.title}
            </Link>
          </>
        ) : (
          ' another session'
        )}
      </span>
      {parent && <OpenSession id={parent.id} label="Open parent" />}
    </div>
  )
}

/**
 * Above the composer of a session whose agent started others: each child, how it is doing and a
 * link to it, so the work under way is visible without scrolling back to the start call.
 */
export function ChildAgentsBar({ sessionId, hostKey }: { sessionId: string; hostKey: string }) {
  const sessions = useHostSessions(hostKey)
  const labels = useAgentLabels(hostKey)
  const children = childSessions(sessionId, sessions)
  const anyLive = children.some((c) => LIVE.includes(childPhase(c)))
  const now = useNow(anyLive)
  const [open, setOpen] = useState(false)
  if (children.length === 0) return null
  const working = children.filter((c) => LIVE.includes(childPhase(c))).length
  const needYou = children.filter((c) => childPhase(c) === 'needs-you').length
  return (
    <div className={`child-bar ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="child-bar-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Bot size={13} />
        <span>
          {children.length} {children.length === 1 ? 'agent' : 'agents'} started here
          {working > 0 ? ` · ${working} working` : ' · all finished'}
          {needYou > 0 ? ` · ${needYou} need${needYou === 1 ? 's' : ''} you` : ''}
        </span>
        {anyLive && <Loader2 size={12} className="spin" />}
        <ChevronRight size={12} className="child-bar-chevron" />
      </button>
      {open && (
        <div className="child-bar-rows">
          {children.map((c) => {
            const phase = childPhase(c)
            const label = agentDisplayName(c.instanceId, labels)
            const liveNow = LIVE.includes(phase)
            const activity = liveNow ? childActivity(c) : undefined
            return (
              <Link
                key={c.id}
                to="/session/$sessionId"
                params={{ sessionId: c.id }}
                className="child-bar-row"
              >
                <AgentAvatar agent={c.instanceId} label={label} />
                <span className="child-bar-name">
                  <strong>{label}</strong> · {c.title}
                  {activity && <span className="child-bar-activity"> — {activity}</span>}
                </span>
                <PhasePill
                  phase={phase}
                  elapsed={Math.max(0, (liveNow ? now : c.updatedAt) - c.createdAt)}
                />
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
