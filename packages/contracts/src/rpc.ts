import { z } from 'zod'
import { GitBranch, GitDiff, GitInfo, GitLog, GitStatus, Project, PullRequest } from './git.ts'
import { ProviderInstance } from './providers.ts'
import { FileContent, FileEntry, TerminalInfo } from './workspace.ts'

/** An ACP agent configured on a host (a command that speaks ACP over stdio). */
export const AcpAgentSummary = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  registryId: z.string().optional(),
})
export type AcpAgentSummary = z.infer<typeof AcpAgentSummary>

/** An entry of the public ACP agent registry. */
export const RegistryEntry = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  /** False for agents that need a binary download, which is not supported yet. */
  installable: z.boolean(),
  reason: z.string().optional(),
})
export type RegistryEntry = z.infer<typeof RegistryEntry>

/** Request/response methods carried in `req`/`res` frames. */
export const RpcMethods = {
  'providers.list': {
    params: z.object({}),
    result: z.array(ProviderInstance),
  },
  'agents.list': {
    params: z.object({}),
    result: z.array(AcpAgentSummary),
  },
  /** Adds an agent from the registry (`registryId`) or from a local command (`command`). */
  'agents.add': {
    params: z.union([
      z.object({ registryId: z.string() }),
      z.object({
        label: z.string().min(1),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    ]),
    result: AcpAgentSummary,
  },
  'agents.remove': {
    params: z.object({ id: z.string() }),
    result: z.object({ removed: z.boolean() }),
  },
  'agents.registry': {
    params: z.object({ query: z.string().optional() }),
    result: z.array(RegistryEntry),
  },
  'projects.list': {
    params: z.object({}),
    result: z.array(Project),
  },
  'projects.add': {
    params: z.object({ path: z.string().min(1) }),
    result: Project,
  },
  'projects.remove': {
    params: z.object({ path: z.string() }),
    result: z.object({ removed: z.boolean() }),
  },
  'git.info': { params: z.object({ cwd: z.string() }), result: GitInfo },
  'git.status': { params: z.object({ cwd: z.string() }), result: GitStatus },
  'git.diff': { params: z.object({ cwd: z.string(), path: z.string() }), result: GitDiff },
  'git.log': { params: z.object({ cwd: z.string() }), result: GitLog },
  'git.branches': { params: z.object({ cwd: z.string() }), result: z.array(GitBranch) },
  /** Commits exactly the listed paths (everything else is left uncommitted). */
  'git.commit': {
    params: z.object({
      cwd: z.string(),
      message: z.string().min(1),
      paths: z.array(z.string()).min(1),
      push: z.boolean().optional(),
    }),
    result: z.object({ hash: z.string(), pushed: z.boolean() }),
  },
  'git.push': { params: z.object({ cwd: z.string() }), result: z.object({}) },
  /** The pull request for the current branch, or null when there is none. */
  'git.pr.get': { params: z.object({ cwd: z.string() }), result: PullRequest.nullable() },
  /** Pushes the branch, then opens a pull request with the GitHub CLI. */
  'git.pr.create': {
    params: z.object({
      cwd: z.string(),
      title: z.string().min(1),
      body: z.string(),
      draft: z.boolean().optional(),
      base: z.string().optional(),
    }),
    result: z.object({ url: z.string() }),
  },
  /** Deletes the worktree a session was started in (its branch is kept). */
  'worktrees.remove': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({ removed: z.boolean() }),
  },
  'terminals.create': {
    params: z.object({
      cwd: z.string(),
      cols: z.number().int().min(2).max(500).optional(),
      rows: z.number().int().min(2).max(200).optional(),
    }),
    result: TerminalInfo,
  },
  'terminals.list': {
    params: z.object({ cwd: z.string().optional() }),
    result: z.array(TerminalInfo),
  },
  /** Ends the shell (if running) and forgets the terminal. */
  'terminals.close': { params: z.object({ id: z.string() }), result: z.object({}) },
  /** Folder contents; `dir` is relative to `cwd` (empty for the root). Folders first. */
  'files.list': {
    params: z.object({ cwd: z.string(), dir: z.string().optional() }),
    result: z.object({ entries: z.array(FileEntry) }),
  },
  'files.read': { params: z.object({ cwd: z.string(), path: z.string() }), result: FileContent },
  /** Saves a file. With `expectedMtime` it refuses to overwrite a newer version on disk. */
  'files.write': {
    params: z.object({
      cwd: z.string(),
      path: z.string(),
      content: z.string(),
      expectedMtime: z.number().optional(),
    }),
    result: z.object({ mtime: z.number() }),
  },
  'files.create': {
    params: z.object({ cwd: z.string(), path: z.string(), type: z.enum(['file', 'dir']) }),
    result: z.object({}),
  },
  /** Paths (relative to `cwd`) whose name or location matches the query, best first. */
  'files.search': {
    params: z.object({ cwd: z.string(), query: z.string() }),
    result: z.object({ paths: z.array(z.string()) }),
  },
  'sessions.create': {
    params: z.object({
      instanceId: z.string(),
      /** Defaults to the server's working directory until projects exist (phase 6). */
      cwd: z.string().optional(),
      title: z.string().optional(),
      permissionMode: z.string().optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      /** Where the agent works. Defaults to the folder itself. */
      workspace: z
        .object({
          mode: z.enum(['local', 'worktree']),
          /** Branch a new worktree starts from; defaults to the repository's main branch. */
          baseBranch: z.string().optional(),
          /** Name for the new worktree's branch; generated when omitted. */
          branch: z.string().optional(),
        })
        .optional(),
    }),
    result: z.object({ sessionId: z.string() }),
  },
  /** Stores a file on the host so a prompt can reference it. Capped at 20 MB. */
  'attachments.upload': {
    params: z.object({
      name: z.string().min(1),
      /** Standard base64 of the file contents. */
      dataBase64: z.string(),
    }),
    result: z.object({ id: z.string(), name: z.string(), size: z.number().int() }),
  },
  'sessions.prompt': {
    params: z.object({
      sessionId: z.string(),
      text: z.string(),
      /** Ids returned by `attachments.upload`. A prompt needs text or at least one attachment. */
      attachments: z.array(z.string()).optional(),
    }),
    result: z.object({}),
  },
  'sessions.interrupt': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({}),
  },
  'sessions.setMode': {
    params: z.object({ sessionId: z.string(), modeId: z.string() }),
    result: z.object({}),
  },
  'sessions.approve': {
    params: z.object({ sessionId: z.string(), requestId: z.string(), optionId: z.string() }),
    result: z.object({}),
  },
} as const

export type RpcMethodName = keyof typeof RpcMethods
export type RpcParams<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['params']>
export type RpcResult<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['result']>
