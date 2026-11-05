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
  commentKind: 'issue' | 'review'
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
  issue?: { number: number; html_url?: string; pull_request?: unknown }
  pull_request?: PullInfo & { number: number; html_url?: string }
  comment?: { id: number; body?: string; user?: Actor; html_url?: string }
  review?: { id: number; body?: string | null; user?: Actor; html_url?: string }
}

const no = (reason: string): Triage => ({ ok: false, reason })

export interface Rules {
  slug: string
  allowed: string[]
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
  if (payload.action !== 'created' && !(event === 'pull_request_review' && payload.action === 'submitted'))
    return no(`action ${payload.action ?? 'none'}`)

  let body: string | undefined
  let author: Actor | undefined
  let commentId: number | undefined
  let kind: 'issue' | 'review' = 'issue'
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
