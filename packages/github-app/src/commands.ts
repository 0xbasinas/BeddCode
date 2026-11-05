export type Verb = 'fix' | 'review' | 'fix-ci' | 'explain' | 'rebase' | 'stop'

/** What a comment asked for. Unset agent, model and effort mean the host's defaults. */
export interface Command {
  verb: Verb
  /** Agent name, from `codex`, `claude` or `agent=<name>`. */
  agent?: string
  model?: string
  effort?: string
  /** The rest of the comment after the command, passed to the agent as extra instructions. */
  extra: string
}

const AGENTS = new Set(['claude', 'codex', 'gemini', 'grok', 'pi'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const clean = (word: string | undefined) => (word ?? '').toLowerCase().replace(/[.!,:;]+$/, '')

/**
 * Reads `@beddcode [codex] [model=x] [effort=high] fix this | review | fix ci | explain |
 * rebase [on main] | stop` from a comment. Returns undefined when the comment does not mention the
 * app or names no known command, so ordinary conversation never starts a job. Quoted lines and
 * code blocks are ignored.
 */
export function parseCommand(body: string, slug: string): Command | undefined {
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/^\s*>.*$/gm, ' ')
  const match = new RegExp(`(^|[^\\w/@-])@${escape(slug)}\\b(?:\\[bot\\])?([\\s\\S]*)`, 'i').exec(text)
  if (!match) return undefined
  const words = (match[2] ?? '').trim().split(/\s+/).filter(Boolean)
  let agent: string | undefined
  let model: string | undefined
  let effort: string | undefined
  let i = 0
  for (; i < words.length; i++) {
    const raw = words[i]!
    const eq = raw.indexOf('=')
    const key = eq > 0 ? raw.slice(0, eq).toLowerCase() : ''
    const value = eq > 0 ? raw.slice(eq + 1).replace(/[,;]+$/, '') : ''
    if (key === 'model' && value) model = value
    else if (key === 'effort' && EFFORTS.has(value.toLowerCase())) effort = value.toLowerCase()
    else if (key === 'agent' && value) agent = value.toLowerCase()
    else if (!key && AGENTS.has(clean(raw))) agent = clean(raw)
    else break
  }
  const rest = words.slice(i)
  const head = clean(rest[0])
  const second = clean(rest[1])
  let verb: Verb | undefined
  let used = 1
  if (head === 'fix' && (second === 'ci' || second === 'tests' || second === 'build')) {
    verb = 'fix-ci'
    used = 2
  } else if (head === 'fix') {
    verb = 'fix'
    if (second === 'this' || second === 'it') used = 2
  } else if (head === 'review' || head === 'explain' || head === 'rebase' || head === 'stop') {
    verb = head
  }
  if (!verb) return undefined
  return { verb, agent, model, effort, extra: rest.slice(used).join(' ').trim() }
}
