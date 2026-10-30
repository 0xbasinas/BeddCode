import { z } from 'zod'
export const GitCommitText = z.object({ message: z.string().trim().min(1).max(8000) })
export const GitPrText = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20_000),
})

/** A folder the user works in on a host. Git details are filled in when it is a repository. */
/** A command saved for a project, run with one click in a terminal (see `projects.setScripts`). */
export const ProjectScript = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(40),
  command: z.string().trim().min(1).max(2000),
  /** Also run it in every new worktree of the project (e.g. installing dependencies). */
  runOnWorktreeCreate: z.boolean().optional(),
})
export type ProjectScript = z.infer<typeof ProjectScript>

export const Project = z.object({
  /** Absolute path (the repository root when the folder is inside a repository). */
  path: z.string(),
  name: z.string(),
  isRepo: z.boolean(),
  branch: z.string().optional(),
  /** Saved commands for this project. */
  scripts: z.array(ProjectScript).optional(),
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

export const PrCheckState = z.enum(['success', 'failure', 'pending', 'skipped'])
export type PrCheckState = z.infer<typeof PrCheckState>

/** What CI said about a branch: its recent Actions runs, and the logs of the checks that failed. */
export const CiReport = z.object({
  pr: z.object({ number: z.number().int(), title: z.string(), url: z.string() }).nullable(),
  branch: z.string().optional(),
  runs: z.array(
    z.object({
      id: z.number(),
      workflow: z.string(),
      title: z.string(),
      status: z.string(),
      conclusion: z.string().optional(),
      sha: z.string().optional(),
      at: z.number().optional(),
      url: z.string(),
    }),
  ),
  failures: z.array(
    z.object({
      /** The failing checks of one run (or one check with no Actions run behind it). */
      checks: z.array(z.string()),
      workflow: z.string().optional(),
      url: z.string().optional(),
      /** The failed steps' output, cut to its end when long. */
      log: z.string().optional(),
      truncated: z.boolean().optional(),
    }),
  ),
})
export type CiReport = z.infer<typeof CiReport>

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
      state: PrCheckState,
      /** Where the check's run or report is, when GitHub says. */
      url: z.string().optional(),
      workflow: z.string().optional(),
    }),
  ),
  reviewDecision: z.string().optional(),
  files: z.array(
    z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() }),
  ),
})
export type PullRequest = z.infer<typeof PullRequest>

/** Whether this host can talk to GitHub, through its own signed-in `gh` CLI. */
export const GithubStatus = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ready'),
    login: z.string(),
    repo: z.string(),
    url: z.string(),
    defaultBranch: z.string().optional(),
    /** ADMIN, MAINTAIN, WRITE, TRIAGE, READ */
    permission: z.string().optional(),
    mergeMethods: z.array(z.enum(['merge', 'squash', 'rebase'])),
    deleteBranchOnMerge: z.boolean(),
  }),
  z.object({ state: z.literal('not-installed') }),
  z.object({ state: z.literal('signed-out'), message: z.string().optional() }),
  z.object({ state: z.literal('no-repo'), login: z.string().optional() }),
  z.object({ state: z.literal('error'), message: z.string() }),
])
export type GithubStatus = z.infer<typeof GithubStatus>

export const PrFilter = z.enum(['open', 'mine', 'review', 'closed'])
export type PrFilter = z.infer<typeof PrFilter>

/** A row of the pull request list. */
export const PullRequestSummary = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  author: z.string(),
  headBranch: z.string(),
  baseBranch: z.string(),
  updatedAt: z.number().int().optional(),
  /** The worst state among its checks; undefined when it has none. */
  checks: PrCheckState.optional(),
  checkCounts: z
    .object({
      total: z.number().int(),
      passed: z.number().int(),
      failed: z.number().int(),
      pending: z.number().int(),
    })
    .optional(),
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED */
  reviewDecision: z.string().optional(),
  added: z.number().int().optional(),
  removed: z.number().int().optional(),
  fromFork: z.boolean().optional(),
})
export type PullRequestSummary = z.infer<typeof PullRequestSummary>

/** One pull request in full: what it says, its checks, reviews, comments and files. */
export const PullRequestDetail = PullRequest.extend({
  author: z.string(),
  updatedAt: z.number().int().optional(),
  closedAt: z.number().int().optional(),
  mergedAt: z.number().int().optional(),
  mergedBy: z.string().optional(),
  headOid: z.string().optional(),
  fromFork: z.boolean().optional(),
  /** MERGEABLE, CONFLICTING, UNKNOWN */
  mergeable: z.string().optional(),
  /** CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, DRAFT, HAS_HOOKS, UNKNOWN */
  mergeState: z.string().optional(),
  added: z.number().int().optional(),
  removed: z.number().int().optional(),
  /** Reviews and comments, oldest first. */
  timeline: z.array(
    z.object({
      kind: z.enum(['comment', 'review']),
      author: z.string(),
      body: z.string(),
      at: z.number().int().optional(),
      /** For reviews: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING */
      state: z.string().optional(),
      url: z.string().optional(),
    }),
  ),
})
export type PullRequestDetail = z.infer<typeof PullRequestDetail>

export const PrAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ready') }),
  z.object({ action: z.literal('draft') }),
  z.object({ action: z.literal('close'), comment: z.string().optional() }),
  z.object({ action: z.literal('reopen') }),
  z.object({ action: z.literal('comment'), body: z.string().min(1).max(65_000) }),
  z.object({
    action: z.literal('merge'),
    method: z.enum(['merge', 'squash', 'rebase']),
    /** Refuse when the branch moved on since the user looked (its head commit then). */
    headOid: z.string().optional(),
    deleteBranch: z.boolean().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
  }),
])
export type PrAction = z.infer<typeof PrAction>
