import type { ConfigOption } from '@beddcode/contracts'
import type { AgentProfile } from './profiles.ts'

/** What the user can pick as "how much to ask" for a session. */
export interface ApprovalMode {
  id: string
  label: string
  description?: string
  /** Marks the "no prompts at all" choice so the UI can warn. */
  dangerous?: boolean
}

/**
 * Where an agent's approval modes come from, in the order the protocol prefers:
 * - `config`: a select config option in the `mode` category (current protocol),
 * - `modes`: the older `modes` list of the session response,
 * - `command`: the agent has neither, but is known (see profiles.ts) to switch with a slash command,
 * - `client`: the agent has neither, so the app offers the one choice every agent can honour:
 *   answering the agent's own permission requests itself.
 */
export type ModeSource = 'config' | 'modes' | 'command' | 'client'

/** The choices for an agent that reports no modes of its own. */
export const CLIENT_MODES: ApprovalMode[] = [
  {
    id: 'ask',
    label: 'Ask before tools',
    description: 'Show each permission request the agent makes and let you decide.',
  },
  {
    id: 'approve-all',
    label: 'Approve every request',
    description:
      'Answer every permission request with Allow. The agent still decides what it asks about.',
    dangerous: true,
  },
]

export interface LegacyModes {
  currentModeId?: string
  availableModes?: { id: string; name: string; description?: string | null }[]
}

export interface ApprovalSetup {
  source: ModeSource
  modes: ApprovalMode[]
  /** The mode in force, or the first one when the agent does not say. */
  current: string
  /** Where to send a change for `config`: the option's id. */
  optionId?: string
  /** The settings that remain once the mode option is taken out (it has its own picker). */
  rest: ConfigOption[]
}

/** The option that selects the session mode, if the agent offers one. */
export function modeOption(options: ConfigOption[]): ConfigOption | undefined {
  return options.find((o) => o.category === 'mode' && o.type === 'select')
}

/**
 * Works out which approval modes a session offers. A `mode` config option wins over the older
 * `modes` list (the protocol asks clients to use it exclusively when both are present).
 */
export function approvalSetup(
  legacy: LegacyModes | undefined,
  options: ConfigOption[],
  profile?: AgentProfile,
): ApprovalSetup {
  const option = modeOption(options)
  if (option) {
    const modes = (option.choices ?? []).map((c) => ({
      id: c.value,
      label: c.name,
      description: c.description,
    }))
    if (modes.length > 0) {
      return {
        source: 'config',
        modes,
        current: String(option.value),
        optionId: option.id,
        rest: options.filter((o) => o !== option),
      }
    }
  }
  const list = (legacy?.availableModes ?? []).map((m) => ({
    id: m.id,
    label: m.name,
    description: m.description ?? undefined,
  }))
  if (list.length > 0) {
    return {
      source: 'modes',
      modes: list,
      current: legacy?.currentModeId ?? list[0]!.id,
      rest: options,
    }
  }
  if (profile) {
    const modes = profile.modes.map(({ command: _command, ...mode }) => mode)
    const current = profile.current()
    return {
      source: 'command',
      modes,
      current: modes.some((m) => m.id === current) ? current! : modes[0]!.id,
      rest: options,
    }
  }
  return { source: 'client', modes: CLIENT_MODES, current: 'ask', rest: options }
}

/**
 * The option to answer a permission request with when approving everything: allow once if the
 * agent offers it, otherwise allow always. Undefined when the agent offers no way to allow.
 */
export function allowOption<T extends { kind: string }>(options: T[]): T | undefined {
  return (
    options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always')
  )
}

/**
 * Whether a permission request is for a tool of one of the host's own MCP servers (BeddCode's
 * agent and browser tools). Those ask the user themselves where it matters, so the agent's own
 * prompt for each call is only noise. Agents name them "<server>__<tool>" in the title or the
 * raw input (Grok: `{ tool_name: "beddcode__browser_click" }`), or give the server by name.
 */
export function isHostTool(
  toolCall: { title?: string | null; rawInput?: unknown },
  servers: readonly string[],
): boolean {
  if (!servers.length) return false
  const raw = (toolCall.rawInput ?? {}) as Record<string, unknown>
  const names = [toolCall.title, raw.tool_name, raw.toolName, raw.name].filter(
    (n): n is string => typeof n === 'string',
  )
  const server = [raw.server_name, raw.serverName, raw.server].find((s) => typeof s === 'string')
  return servers.some(
    (s) => server === s || names.some((n) => n.startsWith(`${s}__`) || n.startsWith(`mcp__${s}__`)),
  )
}
