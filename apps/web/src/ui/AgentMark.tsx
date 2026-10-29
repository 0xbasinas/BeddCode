import { Sparkles } from 'lucide-react'
import { BrandIcon } from './BrandIcon.tsx'

// The marks of the agents BeddCode knows by name, from theSVG (see brandIconData.ts). Claude keeps
// its own colour; Codex and Grok take the text colour so they read on light and dark themes alike.

export type AgentKind = 'claude' | 'codex' | 'grok'

/** Which of the known agents an id or label is ("claude", "acp:grok", "Codex"), if any. */
export function agentKind(...names: (string | undefined)[]): AgentKind | undefined {
  const text = names.filter(Boolean).join(' ').toLowerCase()
  if (/claude|anthropic/.test(text)) return 'claude'
  if (/codex|openai/.test(text)) return 'codex'
  if (/grok|xai/.test(text)) return 'grok'
  return undefined
}

const initialsOf = (label: string) =>
  label
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

const AGENT_NAMES: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok' }

/**
 * The bare mark (theSVG's Claude, Codex and Grok logos), or nothing for an agent without one.
 * Decorative unless `labelled`, since a name is almost always printed beside it.
 */
export function AgentIcon({
  agent,
  label,
  size = 14,
  labelled = false,
}: {
  agent?: string
  label?: string
  size?: number
  labelled?: boolean
}) {
  const kind = agentKind(agent, label)
  if (!kind) return null
  return (
    <BrandIcon
      brand={kind}
      size={size}
      className={`agent-icon ${kind}`}
      label={labelled ? (label ?? AGENT_NAMES[kind]) : undefined}
    />
  )
}

/** A small square with the agent's mark, or its initials when it has none. */
export function AgentMark({
  agent,
  label,
  className = '',
}: {
  agent?: string
  label: string
  className?: string
}) {
  const kind = agentKind(agent, label)
  return (
    <span className={`avatar agent-mark ${className}`} data-agent={kind} aria-hidden>
      {kind ? <AgentIcon agent={agent} label={label} size={11} /> : initialsOf(label)}
    </span>
  )
}

/** Beside a model's name: the agent's mark, or a spark for an agent without one. */
export function ModelIcon({ agent }: { agent?: string }) {
  return agentKind(agent) ? <AgentIcon agent={agent} size={15} /> : <Sparkles size={15} />
}
