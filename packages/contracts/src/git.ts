import { z } from 'zod'
export const GitCommitText = z.object({ message: z.string().trim().min(1).max(8000) })
export const GitPrText = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20_000),
})

/** A folder the user works in on a host. Git details are filled in when it is a repository. */
export const Project = z.object({
  /** Absolute path (the repository root when the folder is inside a repository). */
  path: z.string(),
  name: z.string(),
  isRepo: z.boolean(),
  branch: z.string().optional(),
})
export type Project = z.infer<typeof Project>

export const GitInfo = z.object({
  isRepo: z.boolean(),
  /** Repository root (top level of the working tree this folder belongs to). */
  root: z.string().optional(),
  /** Absolute path of the main checkout; differs from `root` inside a linked worktree. */
  mainRoot: z.string().optional(),
  isWorktree: z.boolean().optional(),
  branch: z.string().optional(),
  detached: z.boolean().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().optional(),
  behind: z.number().int().optional(),
  /** Branch new work usually starts from (origin/HEAD, else main or master). */
  defaultBranch: z.string().optional(),
})
export type GitInfo = z.infer<typeof GitInfo>

/** M modified, A added/untracked, D deleted, R renamed. */
export const GitFileStatus = z.enum(['M', 'A', 'D', 'R'])

export const GitFile = z.object({
  /** Path relative to the repository root, forward slashes. */
  path: z.string(),
  status: GitFileStatus,
  staged: z.boolean(),
  oldPath: z.string().optional(),
  added: z.number().int(),
  removed: z.number().int(),
})
export type GitFile = z.infer<typeof GitFile>

export const GitStatus = z.object({
  branch: z.string().optional(),
  ahead: z.number().int(),
  behind: z.number().int(),
  files: z.array(GitFile),
})
export type GitStatus = z.infer<typeof GitStatus>

export const GitDiff = z.object({
  path: z.string(),
  patch: z.string(),
  added: z.number().int(),
  removed: z.number().int(),
  /** True when the file is binary or the diff was cut short. */
  truncated: z.boolean(),
})
export type GitDiff = z.infer<typeof GitDiff>

export const GitCommit = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  /** Epoch milliseconds. */
  at: z.number().int(),
  added: z.number().int(),
  removed: z.number().int(),
  files: z.array(
    z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() }),
  ),
})
export type GitCommit = z.infer<typeof GitCommit>

export const GitLog = z.object({
  /** Commits on this branch not on its upstream (all branch commits when there is no upstream). */
  unpushed: z.array(GitCommit),
  /** Commits already on the remote, newest first. */
  pushed: z.array(GitCommit),
  /** What the branch is compared against, e.g. `main`. */
  base: z.string().optional(),
})
export type GitLog = z.infer<typeof GitLog>

export const GitBranch = z.object({
  name: z.string(),
  current: z.boolean(),
  /** Epoch milliseconds of the branch tip. */
  at: z.number().int(),
  /** Path of the worktree that has this branch checked out, if any. */
  worktree: z.string().optional(),
})
export type GitBranch = z.infer<typeof GitBranch>

export const PullRequest = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  body: z.string(),
  headBranch: z.string(),
  baseBranch: z.string(),
  createdAt: z.number().int().optional(),
  checks: z.array(
    z.object({
      name: z.string(),
      /** success, failure, pending, skipped */
      state: z.enum(['success', 'failure', 'pending', 'skipped']),
    }),
  ),
  reviewDecision: z.string().optional(),
  files: z.array(
    z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() }),
  ),
})
export type PullRequest = z.infer<typeof PullRequest>
