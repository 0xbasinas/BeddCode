export type Verb = 'fix' | 'review' | 'fix-ci' | 'explain' | 'rebase' | 'stop' | 'ask'

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
 * rebase [on main] | stop` from a comment. Anything else the person wrote becomes `ask`: the
 * agent reads it and decides what to do (see `natural`). A bare mention returns undefined, so it
 * never starts anything. Quoted lines and code blocks are ignored.
 */
export function parseCommand(body: string, slug: string): Command | undefined {
  // GitHub supports both backtick and tilde fences, including unclosed fences.
  const text = body.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm, ' ').replace(/^\s*>.*$/gm, ' ')
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

/** Words that introduce a choice: "with codex", "use sonnet", "on medium". Without one, a name is just a topic. */
const BY = '(?:with|using|use|via|by|on|model|agent)(?:\\s+the)?\\s+'
const LEVEL = '(low|medium|high|xhigh|max)'

/**
 * A comment in plain words: "go ahead and tackle this with claude on sonnet 5.5 on low". Agent,
 * model and effort are picked out wherever they appear. What is actually wanted is left to the
 * agent on the host (`ask`): it reads the whole comment and decides to fix, review, explain,
 * rebase, answer or ask back. Keywords would misread "can you explain why the fix fails?".
 */
function natural(
  text: string,
  found: { agent?: string; model?: string; effort?: string },
): Command | undefined {
  if (!text) return undefined
  let { agent, model, effort } = found
  const lower = text.toLowerCase()
  agent ??= new RegExp(`\\b${BY}(claude|codex|gemini|grok)\\b`).exec(lower)?.[1]
  model ??= new RegExp(`\\b${BY}(sonnet|opus|haiku)\\b`).exec(lower)?.[1]
  effort ??=
    new RegExp(`\\beffort\\s*[=:]?\\s*${LEVEL}\\b`).exec(lower)?.[1] ??
    new RegExp(`\\b${LEVEL}\\s+effort\\b`).exec(lower)?.[1] ??
    new RegExp(`\\bon\\s+${LEVEL}\\b`).exec(lower)?.[1]
  return { verb: 'ask', agent, model, effort, extra: text }
}
