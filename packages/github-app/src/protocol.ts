import type { Command } from './commands.ts'

/** A request for a host to do some work, as the Worker queues it. */
export interface Job {
  id: string
  /** `owner/name` */
  repo: string
  installationId: number
  /** Issue or pull request number. */
  number: number
  isPullRequest: boolean
  command: Command
  sender: string
  /** The comment that asked, so progress reactions and replies can target it. */
  commentId: number
  commentKind: 'issue' | 'review' | 'thread'
  /** Title, body, recent comments and (for `fix ci`) the failing log, as plain text. */
  context: string
  /** Pull requests: the branch to push to. */
  head?: { ref: string; sha: string }
  /** The branch to start from or compare against. */
  base?: { ref: string }
  /** A pull request the text points at ("on PR 102"); its branch is a candidate to start from. */
  baseHint?: { ref: string; number: number }
  url: string
  /** What a host may spend before the job is stopped. */
  budgetMinutes: number
  createdAt: number
  /** Host chosen when queued. Another host serving the repo takes over if this one goes offline. */
  host?: string
}

/** What a host says about itself on every poll. */
export interface HostHello {
  id: string
  label: string
  /** Repos it serves (`owner/name`), or `*`. */
  repos: string[]
  /** Lower is asked first. */
  priority: number
}

export type JobStatus = 'started' | 'working' | 'done' | 'failed' | 'stopped' | 'refused'

export interface JobReport {
  status: JobStatus
  /** Markdown for the reply. Progress-only updates leave it out. */
  message?: string
}
