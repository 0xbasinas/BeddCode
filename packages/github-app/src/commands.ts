export type Verb = 'fix' | 'review' | 'fix-ci' | 'explain' | 'rebase' | 'stop' | 'help'

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
 * rebase [on main] | stop` from a comment, or the same asked in plain words (see `natural`).
 * Returns undefined when the comment mentions the app and says nothing else, so a bare mention
 * never starts anything. Quoted lines and code blocks are ignored.
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
  if (verb) return { verb, agent, model, effort, extra: rest.slice(used).join(' ').trim() }
  return natural((match[2] ?? '').trim(), { agent, model, effort })
}

const FAMILIES = /\b(sonnet|opus|haiku)\b(?:\s*v?\d+(?:\.\d+)?)?/i
const LEVEL = '(low|medium|high|xhigh|max)'
/** Command words, tried in this order of meaning; whichever appears first in the text wins. */
const VERBS: [Verb, RegExp][] = [
  ['stop', /\b(stop|cancel|abort)\b/i],
  [
    'fix-ci',
    /\bfix(?:ing)?\s+(?:the\s+)?(?:failing\s+)?(?:ci|tests?|build|checks?)\b|\b(?:ci|build|checks?)\s+(?:is\s+|are\s+)?(?:failing|broken|red)\b/i,
  ],
  ['rebase', /\brebase\b/i],
  ['review', /\breview\b/i],
  ['explain', /\b(?:explain|summari[sz]e|what(?:'s| is) (?:going on|wrong))\b/i],
  ['fix', /\b(?:fix|tackle|resolve|solve|implement|address|handle|work on|go ahead|do it|make)\b/i],
]

/**
 * A comment in plain words: "go ahead and tackle this with claude on sonnet 5.5 on low". The first
 * command word decides; agent, model and effort are picked out wherever they appear, and the whole
 * text goes to the agent as the request. With no command word the answer is `help`, so the person
 * gets the list of commands instead of silence.
 */
function natural(
  text: string,
  found: { agent?: string; model?: string; effort?: string },
): Command | undefined {
  if (!text) return undefined
  let { agent, model, effort } = found
  const lower = text.toLowerCase()
  agent ??= /\b(claude|codex|gemini|grok)\b/.exec(lower)?.[1]
  model ??= FAMILIES.exec(lower)?.[1]
  effort ??=
    new RegExp(`\\beffort\\s*[=:]?\\s*${LEVEL}\\b`).exec(lower)?.[1] ??
    new RegExp(`\\b${LEVEL}\\s+effort\\b`).exec(lower)?.[1] ??
    new RegExp(`\\bon\\s+${LEVEL}\\b`).exec(lower)?.[1]
  let verb: Verb = 'help'
  let at = Infinity
  for (const [candidate, pattern] of VERBS) {
    const index = pattern.exec(text)?.index
    if (index !== undefined && index < at) {
      verb = candidate
      at = index
    }
  }
  return { verb, agent, model, effort, extra: verb === 'help' ? '' : text }
}
