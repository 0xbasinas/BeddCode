import type { SessionView } from './replica.ts'
import { toolLabel, type Tool } from './toolSummary.ts'

/** The tools BeddCode gives an agent that may start other agents (see the host's agentTools). */
export const AGENT_TOOL_NAMES = [
  'list_agents',
  'start_session',
  'send_message',
  'get_status',
  'read_transcript',
  'wait_for',
  'stop',
  'list_children',
] as const
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number]

const NAMES = AGENT_TOOL_NAMES.join('|')
/**
 * How agents name a call to BeddCode's MCP server: "Using beddcode · start_session" (Claude,
 * Codex), "mcp__beddcode__wait_for", "beddcode/stop", "beddcode: get_status", "beddcode.stop".
 */
const TITLE = new RegExp(`beddcode\\s*(?:·|:|/|\\.|__|_|-|\\s)\\s*(${NAMES})\\b`, 'i')
/** ACP agents may name the tool alone, sometimes with a server prefix of their own. */
const BARE = new RegExp(`^(?:\\S+?(?:__|/|\\.|:)\\s*)?(${NAMES})(?:\\s*\\(.*\\))?$`, 'i')

/** Which agent tool a call is, or undefined for any other tool. */
export function agentToolName(tool: Pick<Tool, 'title' | 'input'>): AgentToolName | undefined {
  const title = tool.title.trim()
  const hit = TITLE.exec(title)
  if (hit) return hit[1]!.toLowerCase() as AgentToolName
  // A bare name ("stop") could be anyone's tool; take it only with arguments that fit ours.
  const bare = BARE.exec(title)
  if (!bare) return undefined
  const name = bare[1]!.toLowerCase() as AgentToolName
  const args = looseJson(tool.input)
  const fits =
    name === 'start_session'
      ? typeof args.agent === 'string' && typeof args.prompt === 'string'
      : name === 'list_agents' || name === 'list_children'
        ? /beddcode/i.test(title)
        : typeof args.session_id === 'string'
  return fits ? name : undefined
}

export function isAgentTool(tool: Pick<Tool, 'title' | 'input'>): boolean {
  return agentToolName(tool) !== undefined
}

type Json = Record<string, unknown>

/**
 * Reads a JSON object even when the provider cut it short (they cap tool output at a few
 * thousand characters): whole when it parses, else the string, number and boolean fields that
 * are there, the last string possibly cut off.
 */
export function looseJson(text: string | undefined): Json {
  if (!text) return {}
  const trimmed = text.trim()
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json
    if (Array.isArray(parsed)) return { items: parsed }
    return {}
  } catch {
    // fall through to field by field
  }
  const out: Json = {}
  const field = /"([a-z_]+)"\s*:\s*(?:"((?:[^"\\]|\\.)*)("?)|(-?\d+(?:\.\d+)?)|(true|false|null))/g
  for (let m = field.exec(trimmed); m; m = field.exec(trimmed)) {
    const key = m[1]!
    if (key in out) continue
    if (m[2] !== undefined) {
      const raw = m[2].replace(/\\$/, '')
      let value: string
      try {
        value = JSON.parse(`"${raw}"`) as string
      } catch {
        value = raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
      out[key] = m[3] ? value : `${value}…`
    } else if (m[4] !== undefined) out[key] = Number(m[4])
    else if (m[5] !== undefined) out[key] = m[5] === 'null' ? null : m[5] === 'true'
  }
  return out
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/** Where a child session stands, in the words the cards use. */
export type ChildPhase = 'starting' | 'running' | 'needs-you' | 'done' | 'failed' | 'stopped'

export const CHILD_PHASE_LABEL: Record<ChildPhase, string> = {
  starting: 'Starting',
  running: 'Working',
  'needs-you': 'Needs your approval',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
}

/** A session that a parent's agent started, as far as the parent's tool call and the host know. */
export interface ChildInfo {
  /** Its session id, once known. */
  id?: string
  /** Whether the session is in this client's replica (so it can be opened). */
  known: boolean
  title?: string
  /** Agent id ("codex", "claude", "grok"). */
  agent?: string
  folder?: string
  branch?: string
  worktree?: boolean
  phase: ChildPhase
  /** What it is doing now: its running tool, the request waiting on the user. */
  activity?: string
  /** Its latest reply, live from its own session. */
  reply?: string
  /** When it was started and when it last moved (epoch ms), for elapsed time. */
  startedAt?: number
  endedAt?: number
}

/** A digest status from the host's answer ("idle", "error"...) as a phase. */
function phaseOfStatus(status: unknown): ChildPhase | undefined {
  switch (status) {
    case 'starting':
      return 'starting'
    case 'running':
      return 'running'
    case 'needs-you':
      return 'needs-you'
    case 'idle':
      return 'done'
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'stopped'
    default:
      return undefined
  }
}

/** A session's phase from its live view. */
export function childPhase(session: SessionView): ChildPhase {
  switch (session.status) {
    case 'needs-you':
      return 'needs-you'
    case 'running':
      return 'running'
    case 'failed':
      return 'failed'
    case 'idle':
      if (session.turns === 0) return 'starting'
      return session.lastTurnReason === 'cancelled' && !session.declined ? 'stopped' : 'done'
  }
}

/** What the session is doing right now, in a few words. */
export function childActivity(session: SessionView): string | undefined {
  if (session.status === 'needs-you') {
    const ask = session.items.findLast(
      (i) =>
        (i.kind === 'approval' && !i.resolvedOptionId && !i.cancelled) ||
        (i.kind === 'question' && !i.answers && !i.dismissed),
    )
    if (ask?.kind === 'approval') return `Asks: ${ask.title}`
    if (ask?.kind === 'question') return `Asks: ${ask.questions[0]?.question ?? 'a question'}`
    return 'Waiting for you'
  }
  if (session.status !== 'running') return undefined
  const tool = session.items.findLast((i) => i.kind === 'tool' && i.status === 'running')
  if (tool?.kind === 'tool') {
    const label = toolLabel(tool)
    return [label.verb, label.prompt, label.target].filter(Boolean).join(' ')
  }
  const last = session.items.at(-1)
  return last?.kind === 'message' && last.role === 'assistant' ? 'Writing…' : 'Thinking…'
}

/** The agent's words since the last message it was sent. */
export function latestReply(session: SessionView): string | undefined {
  const parts: string[] = []
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i]!
    if (item.kind !== 'message') continue
    if (item.role === 'user') break
    parts.unshift(item.text)
  }
  return text(parts.join(''))
}

/** The first line of a long text, cut to fit a row. */
export function preview(value: string | undefined, max = 140): string | undefined {
  if (!value) return undefined
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** Everything a card for one agent-tool call shows. */
export interface AgentToolView {
  name: AgentToolName
  /** "Started", "Waiting for", "Read", in the tense that fits the call's state. */
  verb: string
  child?: ChildInfo
  /** The task it gave (start_session) or the message it sent (send_message). */
  prompt?: string
  /** What the call brought back: the child's reply (wait_for, get_status). */
  reply?: string
  /** The child's conversation as text (read_transcript). */
  transcript?: string
  /** Agents or sessions listed (list_agents, list_children). */
  listed?: { label: string; detail?: string; sessionId?: string }[]
  /** Why the call failed, when it did. */
  error?: string
  /** The call itself is still going. */
  pending: boolean
  /** wait_for came back while the child was still working. */
  stillWorking?: boolean
}

const VERBS: Record<AgentToolName, [string, string]> = {
  list_agents: ['Listing agents', 'Listed agents'],
  start_session: ['Starting', 'Started'],
  send_message: ['Sending a message to', 'Sent a message to'],
  get_status: ['Checking on', 'Checked on'],
  read_transcript: ['Reading the conversation of', 'Read the conversation of'],
  wait_for: ['Waiting for', 'Waited for'],
  stop: ['Stopping', 'Stopped'],
  list_children: ['Listing its sessions', 'Listed its sessions'],
}

/**
 * Reads an agent-tool call into what its card shows. The child's own session, when this client
 * has it, gives the live status, activity and reply; the call's input and answer fill in the rest.
 */
export function agentToolView(
  tool: Tool,
  options: { parentId?: string; sessions?: Record<string, SessionView> } = {},
): AgentToolView | undefined {
  const name = agentToolName(tool)
  if (!name) return undefined
  const sessions = options.sessions ?? {}
  const args = looseJson(tool.input)
  const failed = tool.status === 'failed'
  const result = failed ? {} : looseJson(tool.output)
  const pending = tool.status === 'running'
  const [running, done] = VERBS[name]
  const view: AgentToolView = {
    name,
    verb: pending ? running : tool.status === 'cancelled' ? `${done} (interrupted)` : done,
    pending,
    ...(failed ? { error: text(tool.output) ?? 'The call failed' } : {}),
  }

  if (name === 'list_agents' || name === 'list_children') {
    const items = Array.isArray(result.items) ? (result.items as Json[]) : []
    view.listed = items.map((item) =>
      name === 'list_agents'
        ? { label: text(item.label) ?? text(item.agent) ?? '?', detail: text(item.agent) }
        : {
            label: text(item.title) ?? text(item.session_id) ?? '?',
            detail: [text(item.agent), CHILD_PHASE_LABEL[phaseOfStatus(item.status) ?? 'done']]
              .filter(Boolean)
              .join(' · '),
            sessionId: text(item.session_id),
          },
    )
    return view
  }

  let id = text(result.session_id) ?? text(args.session_id)
  // A start still under way has no answer yet: its session is the parent's newest child since.
  if (!id && name === 'start_session' && options.parentId && !failed) {
    const since = (tool.startedAt ?? tool.at ?? 0) - 2_000
    id = Object.values(sessions)
      .filter((s) => s.parent?.sessionId === options.parentId && s.createdAt >= since)
      .sort((a, b) => a.createdAt - b.createdAt)[0]?.id
  }
  const live = id ? sessions[id] : undefined
  const resultPhase = phaseOfStatus(result.status)
  // A finished wait or status check shows the state it saw then; the rest follow the session live.
  const snapshot = (name === 'wait_for' || name === 'get_status') && !pending && resultPhase
  const phase: ChildPhase = snapshot
    ? resultPhase
    : live
      ? childPhase(live)
      : (resultPhase ??
        (failed ? 'failed' : pending && name === 'start_session' ? 'starting' : 'done'))
  if (id || name === 'start_session') {
    view.child = {
      id,
      known: live !== undefined,
      title: live?.title ?? text(result.title) ?? text(args.title),
      agent: live?.instanceId ?? text(result.agent) ?? text(args.agent),
      folder: live?.cwd ?? text(result.folder) ?? text(args.folder),
      branch: live?.branch ?? text(result.branch),
      worktree: live ? live.worktree !== undefined : args.worktree === true,
      phase,
      activity: live && !snapshot ? childActivity(live) : undefined,
      reply: live ? latestReply(live) : undefined,
      startedAt: live?.createdAt,
      endedAt:
        live && (phase === 'running' || phase === 'needs-you' || phase === 'starting')
          ? undefined
          : live?.updatedAt,
    }
  }
  if (name === 'start_session') view.prompt = text(args.prompt)
  if (name === 'send_message') view.prompt = text(args.text)
  if (name === 'wait_for' || name === 'get_status') {
    view.reply = text(result.reply) ?? text(result.last_reply)
    if (name === 'wait_for' && !pending && !failed) view.stillWorking = result.done === false
  }
  if (name === 'read_transcript') view.transcript = text(result.transcript)
  return view
}

/** The sessions a session's agent started, oldest first. */
export function childSessions(
  parentId: string,
  sessions: Record<string, SessionView>,
): SessionView[] {
  return Object.values(sessions)
    .filter((s) => s.parent?.sessionId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** "Claude", "Codex", "Grok" for an agent id, when the host's own label is not at hand. */
export function agentDisplayName(agent: string | undefined, labels?: Record<string, string>) {
  if (!agent) return 'Agent'
  const label = labels?.[agent]
  if (label) return label
  return agent.charAt(0).toUpperCase() + agent.slice(1)
}
