import type { Job } from '@beddcode/github-app/protocol'

/** Runs `git` in a folder; the bridge's own runner. */
type Git = (cwd: string, args: string[]) => Promise<{ code: number; out: string }>

export interface BaseChoice {
  /** A branch on `origin`, without the `origin/` prefix. */
  ref: string
  /** Said in the reply, so it is clear which branch the work started from and why. */
  reason: string
}

const RECENT = 40
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Remote branches, most recently updated first, without the `origin/` prefix. */
export async function remoteBranches(git: Git, cwd: string): Promise<string[]> {
  const listed = await git(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)',
    'refs/remotes/origin',
  ])
  if (listed.code !== 0) return []
  return listed.out
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^origin\//, ''))
    .filter((name) => name && name !== 'origin' && name !== 'HEAD')
}

/** A branch the text names on purpose: `base=x`, "on branch x", "from x", "x branch". Only real branches count. */
export function namedBranch(text: string, branches: string[]): string | undefined {
  const spoken = text.replace(/[`'"]/g, ' ')
  // Longest names first, so `feature/x-2` wins over `feature/x`.
  for (const name of [...branches].sort((a, b) => b.length - a.length)) {
    const n = escape(name)
    const patterns = [
      `\\b(?:base|branch|from|off|onto|against|based on|work on|start from)\\s*[=:]?\\s*(?:the\\s+)?(?:branch\\s+)?${n}(?![\\w./-])`,
      `\\bon\\s+(?:the\\s+)?(?:branch\\s+)?${n}\\s+branch\\b`,
      `(?<![\\w./-])${n}\\s+branch\\b`,
      `\\bon\\s+branch\\s+${n}(?![\\w./-])`,
    ]
    if (patterns.some((p) => new RegExp(p, 'i').test(spoken))) return name
  }
  return undefined
}

/** File paths mentioned in the text, like `packages/github-app/src/policy.ts`. */
export function mentionedPaths(text: string): string[] {
  const found = text.match(/(?<![\w/.-])[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,6}(?![\w/-])/g) ?? []
  return [...new Set(found)].slice(0, 8)
}

/**
 * Picks the branch the work should start from. A pull request keeps its own branch. Otherwise, in
 * order: a branch the comment names, the branch of a pull request it mentions, the repo's configured
 * base, the most recent branch that has the files it talks about (when the default does not), and
 * finally the default branch.
 */
export async function chooseBase(
  git: Git,
  cwd: string,
  job: Job,
  options: { text: string; configured?: string },
): Promise<BaseChoice> {
  const fallback = job.base?.ref ?? 'main'
  if (job.isPullRequest && job.head) return { ref: job.head.ref, reason: 'the pull request branch' }
  const branches = await remoteBranches(git, cwd)
  const has = (name: string) => branches.includes(name)

  const named = namedBranch(options.text, branches)
  if (named) return { ref: named, reason: 'you named it' }
  if (job.baseHint && has(job.baseHint.ref))
    return { ref: job.baseHint.ref, reason: `the branch of pull request #${job.baseHint.number}` }
  if (options.configured && has(options.configured))
    return { ref: options.configured, reason: 'this repo is set to start from it' }

  // The files the request talks about decide, when the default branch does not have them.
  const paths = mentionedPaths(options.text)
  const base = has(fallback) ? fallback : (branches[0] ?? fallback)
  if (paths.length > 0) {
    const missing = async (ref: string) => {
      const gone: string[] = []
      for (const path of paths)
        if ((await git(cwd, ['cat-file', '-e', `origin/${ref}:${path}`])).code !== 0)
          gone.push(path)
      return gone
    }
    const lacking = await missing(base)
    if (lacking.length > 0 && lacking.length < paths.length + 1) {
      const candidates = branches
        .filter((b) => b !== base && !b.startsWith('beddcode/'))
        .slice(0, RECENT)
      let best: { ref: string; gone: number } | undefined
      for (const ref of candidates) {
        const gone = (await missing(ref)).length
        if (gone === 0) {
          best = { ref, gone }
          break
        }
        if (gone < lacking.length && (!best || gone < best.gone)) best = { ref, gone }
      }
      if (best && best.gone < lacking.length)
        return { ref: best.ref, reason: `\`${lacking[0]}\` is not on \`${base}\` but is on it` }
    }
  }
  return { ref: base, reason: 'the default branch' }
}
