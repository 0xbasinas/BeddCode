import { AgentMark } from '../../ui/AgentMark.tsx'
import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowUpRight,
  Ban,
  Bot,
  Check,
  ChevronRight,
  CornerLeftUp,
  Hand,
  Loader2,
  Square,
  X,
} from 'lucide-react'
import {
  agentDisplayName,
  agentRunStatus,
  agentSteps,
  childActivity,
  childOverlaps,
  childPhase,
  childSessions,
  childrenUsage,
  CHILD_PHASE_LABEL,
  formatDuration,
  preview,
  type AgentStep,
  type ChildPhase,
  type SessionView,
  type Tool,
} from '@beddcode/client-runtime'
import { interrupt, useHostStore } from '../../stores/host.ts'
import { folderName } from '../../ui/format.ts'
import { formatCost, formatTokens } from '../settings/usageFormat.ts'

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

/** The agent's mark in a small square, like the session's own agent chip. */
export function AgentAvatar({ agent, label }: { agent?: string; label: string }) {
  return <AgentMark agent={agent} label={label} className="agent-avatar" />
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

/**
 * A run of calls to BeddCode's agent tools as one block. Folded it is a single line (what it is
 * doing now, or what it did); opened it is one line per step, with the task and the reply a click
 * further. Live state stays in the header and in the bar above the composer, so nothing here moves
 * while the agents work.
 */
export function AgentRunCard({
  tools,
  parentId,
  hostKey,
}: {
  tools: Tool[]
  parentId?: string
  hostKey?: string
}) {
  const sessions = useHostSessions(hostKey)
  const labels = useAgentLabels(hostKey)
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set())
  const steps = agentSteps(tools, { parentId, sessions })
  if (steps.length === 0) return null
  const status = agentRunStatus(steps, sessions)
  const who = (step: AgentStep) =>
    step.child
      ? [agentDisplayName(step.child.agent, labels), step.child.title].filter(Boolean).join(' · ')
      : undefined
  const started = tools[0]?.startedAt
  const ended = tools.at(-1)?.endedAt
  const total =
    !status.pending && started !== undefined && ended !== undefined ? ended - started : 0
  const describe = (step: AgentStep) =>
    [step.verb, who(step) ?? step.what].filter(Boolean).join(' ')
  // What is going on now, what the one step was, or what the run came to.
  const headline = status.pending
    ? describe(status.pending)
    : steps.length === 1
      ? describe(steps[0]!)
      : status.agents > 0
        ? `Coordinated ${status.agents} ${status.agents === 1 ? 'agent' : 'agents'}`
        : 'Agent tools'
  const toggle = (id: string) =>
    setShown((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })
  return (
    <div className={`orch ${open ? 'open' : ''} ${status.pending ? 'live' : ''}`}>
      <button
        type="button"
        className="orch-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight size={12} className="orch-chevron" />
        {status.pending ? <Loader2 size={13} className="spin" /> : <Bot size={13} />}
        <span className="orch-title">
          {headline}
          <span className="orch-meta">
            {steps.length > 1 ? ` · ${steps.length} steps` : ''}
            {total >= 1000 ? ` · ${formatDuration(total)}` : ''}
          </span>
        </span>
        {status.needsYou && (
          <span className="orch-chip needs">
            <Hand size={11} /> Needs your approval
          </span>
        )}
        {status.failed > 0 && <span className="orch-chip failed">{status.failed} failed</span>}
      </button>
      {open && (
        <ul className="orch-steps">
          {steps.map((step) => {
            const name = who(step)
            const expanded = shown.has(step.id)
            const detail = step.text ?? step.reply ?? step.error
            return (
              <li key={step.id} className={`orch-step ${step.error ? 'error' : ''}`}>
                <button
                  type="button"
                  className="orch-step-head"
                  aria-expanded={expanded}
                  disabled={!detail}
                  onClick={() => toggle(step.id)}
                >
                  {step.child ? (
                    <AgentAvatar
                      agent={step.child.agent}
                      label={agentDisplayName(step.child.agent, labels)}
                    />
                  ) : (
                    <Bot size={13} className="orch-icon" />
                  )}
                  <span className="orch-step-text">
                    <span className="agent-verb">{step.verb}</span>
                    {name && <strong> {name}</strong>}
                    {step.what && <span className="orch-what"> {preview(step.what, 120)}</span>}
                    {step.text && step.kind !== 'wait' && (
                      <span className="orch-what"> “{preview(step.text, 90)}”</span>
                    )}
                  </span>
                  {step.ms >= 1000 && <span className="tcall-time">{formatDuration(step.ms)}</span>}
                  {step.pending ? (
                    <Loader2 size={12} className="spin orch-state" />
                  ) : step.error ? (
                    <X size={12} className="orch-state failed" />
                  ) : (
                    <Check size={12} className="orch-state ok" />
                  )}
                </button>
                {expanded && (
                  <div className="orch-body">
                    {step.text && (
                      <OrchText
                        label={step.kind === 'start' ? 'Task' : 'Message'}
                        text={step.text}
                      />
                    )}
                    {step.reply && <OrchText label="Reply" text={step.reply} />}
                    {step.error && <p className="agent-error">{step.error}</p>}
                    {step.child?.id && step.child.known && <OpenSession id={step.child.id} />}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function OrchText({ label, text }: { label: string; text: string }) {
  return (
    <div className="orch-text">
      <span className="orch-label">{label}</span>
      <pre>{text.length > 2000 ? `${text.slice(0, 2000)}…` : text}</pre>
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
 * Above the composer of a session whose agent started others: each child, how it is doing, what it
 * reported, what it used and a way to stop it, so the work under way is visible and controllable
 * without scrolling back to the start call.
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
  const used = childrenUsage(children)
  const overlaps = childOverlaps(children)
  const cost = [
    used.tokens > 0 ? formatTokens(used.tokens) : undefined,
    formatCost(used.costUsd),
  ].filter(Boolean)
  const stop = (id: string) => void interrupt(id, true).catch(() => {})
  return (
    <div className={`child-bar ${open ? 'open' : ''}`}>
      <div className="child-bar-top">
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
            {cost.length > 0 ? ` · ${cost.join(' · ')}` : ''}
          </span>
          {anyLive && <Loader2 size={12} className="spin" />}
          <ChevronRight size={12} className="child-bar-chevron" />
        </button>
        {working > 0 && (
          <button
            type="button"
            className="child-bar-stop-all"
            title="Stop this session and every agent it started"
            onClick={() => stop(sessionId)}
          >
            <Square size={11} /> Stop everything
          </button>
        )}
      </div>
      {open && (
        <div className="child-bar-rows">
          {children.map((c) => {
            const phase = childPhase(c)
            const label = agentDisplayName(c.instanceId, labels)
            const liveNow = LIVE.includes(phase)
            const activity = liveNow ? childActivity(c) : undefined
            const clash = overlaps[c.id]
            return (
              <div key={c.id} className="child-bar-item">
                <Link
                  to="/session/$sessionId"
                  params={{ sessionId: c.id }}
                  className="child-bar-row"
                >
                  <AgentAvatar agent={c.instanceId} label={label} />
                  <span className="child-bar-name">
                    <strong>{label}</strong> · {c.title}
                    {activity && <span className="child-bar-activity"> — {activity}</span>}
                    {!liveNow && c.result && (
                      <span
                        className={`child-bar-result ${c.result.status}`}
                        title={c.result.summary}
                      >
                        {' '}
                        — reported {c.result.status}: {preview(c.result.summary, 90)}
                      </span>
                    )}
                    {!liveNow && !c.result && phase === 'done' && c.parent && (
                      <span className="child-bar-activity"> — no report</span>
                    )}
                    {clash && (
                      <span
                        className="child-bar-overlap"
                        title={clash.map((o) => `${o.title}: ${o.files.join(', ')}`).join('\n')}
                      >
                        {' '}
                        · same files as {clash.map((o) => o.title).join(', ')}
                      </span>
                    )}
                  </span>
                  {c.usage && c.usage.tokens > 0 && (
                    <span className="child-bar-cost">{formatTokens(c.usage.tokens)}</span>
                  )}
                  <PhasePill
                    phase={phase}
                    elapsed={Math.max(0, (liveNow ? now : c.updatedAt) - c.createdAt)}
                  />
                </Link>
                {liveNow && (
                  <button
                    type="button"
                    className="child-bar-stop"
                    aria-label={`Stop ${label}: ${c.title}`}
                    title="Stop this agent and anything it started"
                    onClick={() => stop(c.id)}
                  >
                    <Square size={11} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
