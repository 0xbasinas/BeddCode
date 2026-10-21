import { useEffect, useState } from 'react'
import {
  Ban,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react'
import {
  defaultOpen,
  formatDuration,
  summarizeTools,
  toolDuration,
  toolLabel,
  type Tool,
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

function StatusIcon({ status }: { status: Tool['status'] }) {
  switch (status) {
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

/** One tool call: what it did to what, how it went and how long it took; its output opens on click. */
function ToolCall({ tool, now }: { tool: Tool; now: number }) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[tool.toolKind]
  const label = toolLabel(tool)
  const ms = toolDuration(tool, now)
  const output = tool.output?.trim()

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
      {ms !== undefined && tool.status !== 'cancelled' && (
        <span className="tcall-time">{formatDuration(ms)}</span>
      )}
      <span className="tcall-status">
        <StatusIcon status={tool.status} />
      </span>
      {output && <ChevronRight size={13} className="tcall-chevron" />}
    </>
  )

  return (
    <div className={`tcall ${tool.status} ${open ? 'open' : ''}`}>
      {output ? (
        <button className="tcall-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {row}
        </button>
      ) : (
        <div className="tcall-row">{row}</div>
      )}
      {open && output && (
        <pre className="tcall-output">
          <code>{output}</code>
        </pre>
      )}
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
