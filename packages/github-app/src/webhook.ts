import { parseCommand, type Command } from './commands.ts'
import { allowedSender, fromFork, type Actor } from './policy.ts'

/** A comment that asks the app for something, once the sender and the command have been checked. */
export interface Request {
  repo: string
  installationId: number
  number: number
  isPullRequest: boolean
  sender: string
  command: Command
  commentId: number
  commentKind: 'issue' | 'review' | 'thread'
  url: string
  /** Set when the webhook already carries the pull request, so no extra lookup is needed. */
  pull?: PullInfo
}

export interface PullInfo {
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null }
  base?: { ref?: string; repo?: { full_name?: string } | null }
}

export type Triage = { ok: true; request: Request } | { ok: false; reason: string }

interface Payload {
  action?: string
  installation?: { id?: number }
  repository?: { full_name?: string; archived?: boolean }
  sender?: Actor
  issue?: { number: number; html_url?: string; pull_request?: unknown; body?: string | null; user?: Actor }
  pull_request?: PullInfo & { number: number; html_url?: string; body?: string | null; user?: Actor }
  comment?: { id: number; body?: string; user?: Actor; html_url?: string }
  review?: { id: number; body?: string | null; user?: Actor; html_url?: string }
  label?: { name?: string }
}

const no = (reason: string): Triage => ({ ok: false, reason })

export interface Rules {
  slug: string
  allowed: string[]
}

/**
 * Labels that start a job, named after the app: `beddcode` (fix an issue, review a pull request) or
 * `beddcode:fix`, `beddcode:review`, `beddcode:fix-ci`, `beddcode:explain`, `beddcode:rebase`.
 */
export function labelCommand(name: string | undefined, slug: string, isPullRequest: boolean): Command | undefined {
  const label = (name ?? '').trim().toLowerCase()
  if (label === slug.toLowerCase())
    return { verb: isPullRequest ? 'review' : 'fix', extra: '' }
  const verb = new RegExp(`^${slug.toLowerCase()}[:/ -](fix|review|fix-ci|explain|rebase)$`).exec(label)?.[1]
  return verb ? { verb: verb as Command['verb'], extra: '' } : undefined
}

/**
 * Decides whether a webhook delivery is a command from someone allowed to give one. Everything
 * else (other events, edits, deletions, bots, strangers, forks, plain conversation) is ignored
 * with a reason that is only ever logged, never answered, so outsiders learn nothing.
 */
export function triage(event: string, payload: Payload, rules: Rules): Triage {
  const repo = payload.repository?.full_name
  const installationId = payload.installation?.id
  if (!repo || !installationId) return no('no repository or installation')
  if (payload.repository?.archived) return no('archived repository')
  // A command in the text of a new issue or pull request, like "@beddcode please fix this".
  if (payload.action === 'opened' && (event === 'issues' || event === 'pull_request')) {
    const isPullRequest = event === 'pull_request'
    const thing = isPullRequest ? payload.pull_request : payload.issue
    const number = thing?.number
    const author = thing?.user
    if (!number || !thing?.body) return no('empty body')
    if (!allowedSender(author, rules.allowed) || !allowedSender(payload.sender, rules.allowed))
      return no('sender not allowed')
    const command = parseCommand(thing.body, rules.slug)
    if (!command) return no('no command')
    if (isPullRequest && fromFork(payload.pull_request ?? {})) return no('pull request from a fork')
    return {
      ok: true,
      request: {
        repo,
        installationId,
        number,
        isPullRequest,
        sender: author!.login,
        command,
        commentId: 0,
        commentKind: 'thread',
        url: thing.html_url ?? '',
        pull: isPullRequest ? payload.pull_request : undefined,
      },
    }
  }
  if (payload.action === 'labeled' && (event === 'issues' || event === 'pull_request')) {
    // Whoever applied the label must be allowed; that is the only identity a label carries.
    const isPullRequest = event === 'pull_request'
    const number = isPullRequest ? payload.pull_request?.number : payload.issue?.number
    const command = labelCommand(payload.label?.name, rules.slug, isPullRequest)
    if (!number || !command) return no('not a command label')
    if (!allowedSender(payload.sender, rules.allowed)) return no('sender not allowed')
    if (isPullRequest && fromFork(payload.pull_request ?? {})) return no('pull request from a fork')
    return {
      ok: true,
      request: {
        repo,
        installationId,
        number,
        isPullRequest,
        sender: payload.sender!.login,
        command,
        commentId: 0,
        commentKind: 'thread',
        url: (isPullRequest ? payload.pull_request?.html_url : payload.issue?.html_url) ?? '',
        pull: isPullRequest ? payload.pull_request : undefined,
      },
    }
  }
  if (payload.action !== 'created' && !(event === 'pull_request_review' && payload.action === 'submitted'))
    return no(`action ${payload.action ?? 'none'}`)

  let body: string | undefined
  let author: Actor | undefined
  let commentId: number | undefined
  let kind: 'issue' | 'review' | 'thread' = 'issue'
  let number: number | undefined
  let isPullRequest = false
  let url = ''
  let pull: PullInfo | undefined

  if (event === 'issue_comment') {
    body = payload.comment?.body
    author = payload.comment?.user
    commentId = payload.comment?.id
    number = payload.issue?.number
    isPullRequest = !!payload.issue?.pull_request
    url = payload.comment?.html_url ?? payload.issue?.html_url ?? ''
  } else if (event === 'pull_request_review_comment') {
    body = payload.comment?.body
    author = payload.comment?.user
    commentId = payload.comment?.id
    kind = 'review'
    number = payload.pull_request?.number
    isPullRequest = true
    pull = payload.pull_request
    url = payload.comment?.html_url ?? payload.pull_request?.html_url ?? ''
  } else if (event === 'pull_request_review') {
    // A review's own body is treated like a comment; reactions to it go to the pull request.
    body = payload.review?.body ?? undefined
    author = payload.review?.user
    commentId = payload.review?.id
    kind = 'thread'
    number = payload.pull_request?.number
    isPullRequest = true
    pull = payload.pull_request
    url = payload.review?.html_url ?? payload.pull_request?.html_url ?? ''
  } else return no(`event ${event}`)

  if (!body || !number || !commentId) return no('empty comment')
  // The person who wrote the comment must be allowed, and so must whoever the webhook says sent it.
  if (!allowedSender(author, rules.allowed) || !allowedSender(payload.sender, rules.allowed))
    return no('sender not allowed')
  const command = parseCommand(body, rules.slug)
  if (!command) return no('no command')
  if (pull && fromFork(pull)) return no('pull request from a fork')
  return {
    ok: true,
    request: {
      repo,
      installationId,
      number,
      isPullRequest,
      sender: author!.login,
      command,
      commentId,
      commentKind: kind,
      url,
      pull,
    },
  }
}
