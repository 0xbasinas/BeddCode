import { useEffect, useId, useState } from 'react'
import {
  Ban,
  Check,
  ChevronRight,
  FileText,
  Hand,
  Loader2,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react'
import {
  approvalWait,
  defaultOpen,
  formatDuration,
  ranWithoutAsking,
  summarizeTools,
  toolDuration,
  toolLabel,
  toolDetails,
  toolPhase,
  type Tool,
  type ToolPhase,
} from './toolSummary.ts'

const ICONS = {
  command: SquareTerminal,
  read: FileText,
  edit: Pencil,
  search: Search,
  other: Wrench,
} as const

/** Re-renders every second while anything runs, so durations tick. */
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

function StatusIcon({ phase }: { phase: ToolPhase }) {
  switch (phase) {
    case 'awaiting-approval':
      return <Hand size={13} aria-label="Waiting for your approval" />
    case 'approved':
      return <Loader2 size={13} className="spin" aria-label="Approved, waiting for the agent" />
    case 'denied':
      return <X size={13} aria-label="Denied" />
    case 'running':
      return <Loader2 size={13} className="spin" aria-label="Running" />
    case 'ok':
      return <Check size={13} aria-label="Done" />
    case 'failed':
      return <X size={13} aria-label="Failed" />
    case 'cancelled':
      return <Ban size={13} aria-label="Stopped" />
  }
}

/** What a tool call was given and what it gave back, under its row when opened. */
function ToolDetails({ tool, now, id }: { tool: Tool; now: number; id: string }) {
  const output = tool.output?.trim()
  return (
    <div className="tcall-details" id={id}>
      <dl className="tcall-facts">
        {toolDetails(tool, now).map((d, i) => (
          <div key={i} className="tcall-fact">
            <dt>{d.label}</dt>
            <dd className={d.mono ? 'mono' : undefined}>{d.value}</dd>
          </div>
        ))}
      </dl>
      {tool.input && (
        <section className="tcall-block">
          <h4>Input</h4>
          <pre className="tcall-output">
            <code>{tool.input}</code>
          </pre>
        </section>
      )}
      {output ? (
        <section className="tcall-block">
          <h4>{tool.status === 'failed' ? 'Error' : 'Output'}</h4>
          <pre className={`tcall-output ${tool.status === 'failed' ? 'error' : ''}`}>
            <code>{output}</code>
          </pre>
        </section>
      ) : (
        tool.status !== 'running' && <p className="tcall-none">No output</p>
      )}
    </div>
  )
}

/** One tool call: what it did to what, how it went and how long it took; its details open on click. */
function ToolCall({ tool, now }: { tool: Tool; now: number }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const Icon = ICONS[tool.toolKind]
  const label = toolLabel(tool)
  const ms = toolDuration(tool, now)
  const waited = approvalWait(tool, now)
  const phase = toolPhase(tool)
  const timing = [
    ms !== undefined ? `Ran for ${formatDuration(ms)}` : undefined,
    waited !== undefined ? `waited ${formatDuration(waited)} for your approval` : undefined,
  ]
    .filter(Boolean)
    .join(', ')

  const row = (
    <>
      <Icon size={14} className="tcall-kind" />
      <span className="tcall-text" title={tool.title}>
        {label.verb && <span className="tcall-verb">{label.verb}</span>}
        <code>
          {label.prompt && <span className="tcall-prompt">{label.prompt} </span>}
          {label.target}
        </code>
      </span>
      {ranWithoutAsking(tool) && (
        <span
          className="tcall-tag"
          title="The agent ran this without asking you. Its own rules allow some commands (such as ls, cat or git status) without a prompt, and anything you allowed for the whole session."
        >
          no prompt
        </span>
      )}
      {phase === 'awaiting-approval' && <span className="tcall-tag wait">needs approval</span>}
      {phase === 'approved' && <span className="tcall-tag">approved</span>}
      {phase === 'denied' && <span className="tcall-tag">denied</span>}
      {(ms !== undefined || (waited !== undefined && waited >= 1000)) &&
        tool.status !== 'cancelled' && (
          <span className="tcall-time" title={timing}>
            {ms !== undefined && formatDuration(ms)}
            {waited !== undefined && waited >= 1000 && (
              <span className="tcall-wait">
                {ms !== undefined ? ' · ' : ''}
                {formatDuration(waited)} approval
              </span>
            )}
          </span>
        )}
      <span className="tcall-status">
        <StatusIcon phase={phase} />
      </span>
      <ChevronRight size={13} className="tcall-chevron" aria-hidden />
    </>
  )

  return (
    <div className={`tcall ${tool.status} ${phase} ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="tcall-row"
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        aria-label={`${open ? 'Hide' : 'Show'} details: ${tool.title}`}
        onClick={() => setOpen((o) => !o)}
      >
        {row}
      </button>
      {open && <ToolDetails tool={tool} now={now} id={detailsId} />}
    </div>
  )
}

/**
 * A run of tool calls as one unit. Finished runs fold into a one-line summary; a run that is still
 * going, failed or is short stays open, so what matters is never hidden.
 */
export function ToolGroup({ tools }: { tools: Tool[] }) {
  const running = tools.filter((t) => t.status === 'running')
  const now = useNow(running.length > 0)
  const [choice, setChoice] = useState<boolean | undefined>(undefined)
  const open = choice ?? defaultOpen(tools)
  const foldable = tools.length > 2
  const current = running.at(-1)

  const times = tools.flatMap((t) =>
    toolDuration(t, now) !== undefined ? [toolDuration(t, now)!] : [],
  )
  const total = times.length > 0 ? times.reduce((a, b) => a + b, 0) : undefined
  const failed = tools.filter((t) => t.status === 'failed').length

  return (
    <div className={`tgroup ${running.length > 0 ? 'running' : ''}`}>
      {foldable && (
        <button className="tgroup-head" aria-expanded={open} onClick={() => setChoice(!open)}>
          <ChevronRight size={14} className={`tgroup-chevron ${open ? 'open' : ''}`} />
          {current ? <Loader2 size={13} className="spin" /> : null}
          <span className="tgroup-summary">
            {current ? (
              <>
                {toolLabel(current).verb} <code>{toolLabel(current).target}</code>
              </>
            ) : (
              summarizeTools(tools)
            )}
          </span>
          {failed > 0 && <span className="tgroup-failed">{failed} failed</span>}
          {total !== undefined && !current && (
            <span className="tcall-time">{formatDuration(total)}</span>
          )}
          {current && tools.length > 1 && (
            <span className="tcall-time">
              {tools.length - running.length} of {tools.length} done
            </span>
          )}
        </button>
      )}
      {open && (
        <div className="tgroup-rows">
          {tools.map((tool) => (
            <ToolCall key={tool.id} tool={tool} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}
