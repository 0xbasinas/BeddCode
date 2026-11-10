import { z } from 'zod'
import {
  GitBranch,
  GitDiff,
  GitInfo,
  GitLog,
  GitStatus,
  Project,
  ProjectScript,
  CiReport,
  PrCleanupResult,
  PullRequest,
  PullRequestDetail,
  PullRequestSummary,
  GithubStatus,
  PrFilter,
  PrAction,
} from './git.ts'
import {
  Device,
  MetricPlatform,
  MetricRecord,
  PairingCode,
  RelaySettings,
  WarmPoolChange,
  WarmPoolSettings,
  McpGatewaySettings,
  TailnetStatus,
  GcReport,
  HostStats,
} from './hosts.ts'
import { ConfigOption, SlashCommand, StoredEvent } from './events.ts'
import { PermissionModeOption, ProviderInstance } from './providers.ts'
import {
  FileContent,
  FileEntry,
  FileMedia,
  FolderListing,
  PreviewEntry,
  TerminalInfo,
} from './workspace.ts'
import { Design, DesignProject, DesignSummary } from './design.ts'
import { UsageLimits, UsageSummary } from './usage.ts'
import {
  OrchestrationSettings,
  OrchestrationApproval,
  OrchestrationTemplate,
  AlertEvents,
  AlertSettings,
  TelegramStatus,
  PushRegistration,
  Schedule,
  ScheduleInput,
  ScheduleRun,
  SentAlert,
} from './automation.ts'

/** An ACP agent configured on a host (a command that speaks ACP over stdio). */
export const AcpAgentSummary = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  registryId: z.string().optional(),
  /** Environment variables the agent is started with (kept on this host's own configuration). */
  env: z.record(z.string(), z.string()).default({}),
})
export type AcpAgentSummary = z.infer<typeof AcpAgentSummary>

/** An entry of the public ACP agent registry. */
export const RegistryEntry = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  /** False when there is no way to run it on this machine (for example no build for this OS). */
  installable: z.boolean(),
  reason: z.string().optional(),
  /** Set when adding the agent downloads a program; the user must agree first. */
  download: z
    .object({
      host: z.string(),
      /** The registry publishes a checksum, which is verified. Without one the file is trusted as is. */
      verified: z.boolean(),
    })
    .optional(),
})
export type RegistryEntry = z.infer<typeof RegistryEntry>

/** An ACP agent BeddCode knows how to start, and whether this machine has it. */
export const KnownAgent = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  /** The command (and anything it needs) is on this machine's PATH. */
  installed: z.boolean(),
  /** What is missing from PATH when it is not installed. */
  missing: z.array(z.string()),
  /** Already added as one of this host's agents. */
  added: z.boolean(),
})
export type KnownAgent = z.infer<typeof KnownAgent>

/** What an agent offers for a session that has not started yet. */
export const AgentPreview = z.object({
  modes: z.array(PermissionModeOption),
  currentModeId: z.string().optional(),
  config: z.array(ConfigOption),
  commands: z.array(SlashCommand),
  observedAt: z.number().optional(),
  snapshot: z.boolean().optional(),
})
export type AgentPreview = z.infer<typeof AgentPreview>

/** A conversation an agent's CLI has on disk. */
export const HistoryEntry = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.number().int().optional(),
  cwd: z.string().optional(),
  /** True when this conversation is already a session in BeddCode. */
  imported: z.boolean().optional(),
})
export type HistoryEntry = z.infer<typeof HistoryEntry>

/**
 * What a project allows one MCP server to do, kept by BeddCode per folder (ToolHive-style
 * policy, but local): a server can be switched off, and tool lists can allow or deny calls.
 * `mcp.test` enforces it for BeddCode's own probing; agents are told the policy in their context.
 */
export const McpServerPolicy = z.object({
  /** False: the server is off for this project. */
  enabled: z.boolean().optional(),
  /** When set, only these tools may be called through the server. */
  toolsAllow: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  /** These tools are always blocked, whatever toolsAllow says. */
  toolsDeny: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
})
export type McpServerPolicy = z.infer<typeof McpServerPolicy>

export const McpServer = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http', 'sse', 'unknown']),
  /** The command line, or the URL. */
  target: z.string(),
  status: z.enum(['connected', 'failed', 'needs-auth', 'disabled', 'pending', 'unknown']),
  /** Where the agent's own config keeps it (user, project, local), when it says. */
  scope: z.string().optional(),
  toolCount: z.number().int().optional(),
  error: z.string().optional(),
  /** The project's policy for this server, when one is set. */
  policy: McpServerPolicy.optional(),
})
export type McpServer = z.infer<typeof McpServer>

export const McpServerInput = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[\w.-]+$/, 'Letters, digits, dots, dashes and underscores only'),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z
    .record(
      z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
      z.string().refine((v) => !/[\r\n]/.test(v)),
    )
    .optional(),
  bearerToken: z
    .string()
    .refine((v) => !/[\r\n]/.test(v))
    .optional(),
  scope: z.enum(['user', 'project', 'local']).optional(),
})
export type McpServerInput = z.infer<typeof McpServerInput>

/** Request/response methods carried in `req`/`res` frames. */
export const RpcMethods = {
  'session.events.page': {
    params: z.object({
      sessionId: z.string(),
      beforeSeq: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(1000),
    }),
    result: z.object({ events: z.array(StoredEvent), hasMore: z.boolean() }),
  },
  'orchestration.templates.start': {
    params: z.object({ sessionId: z.string(), templateId: z.string(), tasks: z.array(z.string()) }),
    result: z.unknown(),
  },
  'orchestration.templates.list': { params: z.object({}), result: z.array(OrchestrationTemplate) },
  'orchestration.templates.save': { params: OrchestrationTemplate, result: OrchestrationTemplate },
  'orchestration.templates.delete': { params: z.object({ id: z.string() }), result: z.object({}) },
  'orchestration.settings.get': { params: z.object({}), result: OrchestrationSettings },
  'orchestration.settings.set': { params: OrchestrationSettings, result: OrchestrationSettings },
  'orchestration.approvals.list': { params: z.object({}), result: z.array(OrchestrationApproval) },
  'orchestration.approvals.approve': {
    params: z.object({ id: z.string() }),
    result: OrchestrationApproval,
  },
  'orchestration.approvals.deny': {
    params: z.object({ id: z.string() }),
    result: OrchestrationApproval,
  },
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
      z.object({
        registryId: z.string(),
        /** Required when the entry downloads a program (see RegistryEntry.download). */
        acceptDownload: z.boolean().optional(),
      }),
      z.object({
        label: z.string().min(1),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    ]),
    result: AcpAgentSummary,
  },
  /** Changes how an agent is started. Its id, and where it came from, stay the same. */
  'agents.update': {
    params: z.object({
      id: z.string(),
      label: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()),
    }),
    result: AcpAgentSummary,
  },
  /** Tokens (and cost) the agents used over the last `days`, by model, session and day. */
  'usage.summary': {
    params: z.object({ days: z.number().int().min(1).max(90).default(7) }),
    result: UsageSummary,
  },
  /** Plan limits each agent reports (5-hour and weekly windows), for those that report them. */
  'usage.limits': {
    params: z.object({}),
    result: z.array(UsageLimits),
  },
  'agents.remove': {
    params: z.object({ id: z.string() }),
    result: z.object({ removed: z.boolean() }),
  },
  /** Well-known ACP agents (from acpx's launch table) and which of them this host has installed. */
  'agents.known': { params: z.object({}), result: z.array(KnownAgent) },
  'agents.registry': {
    params: z.object({ query: z.string().optional() }),
    result: z.array(RegistryEntry),
  },
  'host.claudeBackend.get': {
    params: z.object({}),
    result: z.object({ claudeBackend: z.enum(['sdk', 'cli']) }),
  },
  'host.claudeBackend.set': {
    params: z.object({ claudeBackend: z.enum(['sdk', 'cli']) }),
    result: z.object({ claudeBackend: z.enum(['sdk', 'cli']) }),
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
  /** Replaces the saved commands of an added folder. */
  'projects.setScripts': {
    params: z.object({ path: z.string().min(1), scripts: z.array(ProjectScript).max(20) }),
    result: Project,
  },
  'projects.setInstructions': {
    params: z.object({ path: z.string().min(1), instructions: z.string().max(32000) }),
    result: Project,
  },
  'projects.setClaudeBackend': {
    params: z.object({ path: z.string().min(1), claudeBackend: z.enum(['sdk', 'cli']).nullable() }),
    result: Project,
  },
  /** Runs `git init` in a folder that was added but is not a repository yet. */
  'projects.initGit': {
    params: z.object({ path: z.string().min(1) }),
    result: Project,
  },
  /**
   * The subfolders of a folder on the host (its home folder when `path` is omitted), so a folder
   * can be picked on a machine the system's own picker cannot see. Folders only, never files.
   */
  'folders.browse': {
    params: z.object({ path: z.string().min(1).optional(), showHidden: z.boolean().optional() }),
    result: FolderListing,
  },
  'git.info': { params: z.object({ cwd: z.string() }), result: GitInfo },
  'git.status': { params: z.object({ cwd: z.string() }), result: GitStatus },
  /** One file's diff; `offset`/`maxLines` page through a long patch (default first 600 lines). */
  'git.diff': {
    params: z.object({
      cwd: z.string(),
      path: z.string(),
      offset: z.number().int().min(0).optional(),
      maxLines: z.number().int().min(1).max(20000).optional(),
    }),
    result: GitDiff,
  },
  'git.log': { params: z.object({ cwd: z.string() }), result: GitLog },
  'git.branches': { params: z.object({ cwd: z.string() }), result: z.array(GitBranch) },
  /** Generate editable Git text with an installed agent; this never commits or pushes. */
  'git.generate': {
    params: z
      .object({
        sessionId: z.string().min(1).optional(),
        cwd: z.string().min(1).optional(),
        instanceId: z.string(),
        kind: z.enum(['commit', 'pr']),
        paths: z.array(z.string()).max(200).optional(),
        base: z.string().optional(),
      })
      .refine((p) => Boolean(p.sessionId || p.cwd), 'Choose a session or working folder'),
    result: z.object({
      message: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      truncated: z.boolean(),
    }),
  },
  /** Commits exactly the listed paths (everything else is left uncommitted). */
  'git.commit': {
    params: z.object({
      cwd: z.string(),
      message: z.string().min(1),
      paths: z.array(z.string()).min(1),
      push: z.boolean().optional(),
    }),
    result: z.object({ hash: z.string(), pushed: z.boolean(), pushError: z.string().optional() }),
  },
  'git.push': { params: z.object({ cwd: z.string() }), result: z.object({}) },
  /** The pull request for the current branch, or null when there is none. */
  'git.pr.get': {
    params: z.object({
      cwd: z.string(),
      /** The branch a session was on and the repository it belongs to, for when `cwd` is gone. */
      branch: z.string().optional(),
      repo: z.string().optional(),
    }),
    result: PullRequest.nullable(),
  },
  /**
   * Tidies up after a pull request was merged: brings the base branch up to date in the main
   * checkout, removes the worktree the branch was in, and deletes the branch. Each step is checked
   * for safety (local commits the pull request does not have, uncommitted files) and is skipped,
   * with the reason, when it is not safe.
   */
  'git.pr.cleanup': {
    params: z.object({
      cwd: z.string(),
      number: z.number().int().positive(),
      /** The session working in `cwd`, so its agent is stopped before its worktree goes. */
      sessionId: z.string().optional(),
      updateBase: z.boolean(),
      removeWorktree: z.boolean(),
      deleteBranch: z.boolean(),
    }),
    result: PrCleanupResult,
  },
  /** The branch's recent GitHub Actions runs and the logs of its failed checks, for an agent to fix. */
  'git.ci.report': { params: z.object({ cwd: z.string() }), result: CiReport },
  /** Whether the host's GitHub CLI is installed and signed in, and the folder's GitHub repo. */
  'git.gh.status': { params: z.object({ cwd: z.string() }), result: GithubStatus },
  /** The repo's pull requests: open, the user's own, those awaiting their review, or closed. */
  'git.pr.list': {
    params: z.object({
      cwd: z.string(),
      filter: PrFilter,
      limit: z.number().int().min(1).max(100).optional(),
    }),
    result: z.object({ items: z.array(PullRequestSummary) }),
  },
  'git.pr.view': {
    params: z.object({ cwd: z.string(), number: z.number().int().positive() }),
    result: PullRequestDetail,
  },
  /** Mark ready, back to draft, close, reopen, comment on or merge a pull request. */
  'git.pr.act': {
    params: z.object({ cwd: z.string(), number: z.number().int().positive(), do: PrAction }),
    result: z.object({ message: z.string().optional() }),
  },
  /** Checks a pull request out: here (switching this folder's branch) or into a new worktree. */
  'git.pr.checkout': {
    params: z.object({
      cwd: z.string(),
      number: z.number().int().positive(),
      worktree: z.boolean().optional(),
    }),
    result: z.object({ branch: z.string(), path: z.string() }),
  },
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
  /**
   * Code editors (and the system file manager) installed on the host, preferred first.
   * `canOpen` is false unless this connection is the host machine itself: an editor opens on the
   * host's screen, which a phone or another computer cannot see.
   */
  'editors.list': {
    params: z.object({}),
    result: z.object({
      editors: z.array(z.object({ id: z.string(), label: z.string() })),
      canOpen: z.boolean(),
      /** The host's `process.platform`, so the file manager can show that system's mark. */
      platform: z.string().optional(),
    }),
  },
  /** Opens a folder, and optionally a file at a line, in an installed editor. Loopback only. */
  'editors.open': {
    params: z.object({
      editor: z.string().min(1),
      cwd: z.string().min(1),
      path: z.string().optional(),
      line: z.number().int().positive().optional(),
      column: z.number().int().positive().optional(),
    }),
    result: z.object({ opened: z.boolean() }),
  },
  /** Deletes the worktree a session was started in (its branch is kept). */
  'worktrees.remove': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({ removed: z.boolean() }),
  },
  'worktrees.preflight': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({
      path: z.string(),
      branch: z.string().optional(),
      files: z.array(z.string()),
      ahead: z.number().optional(),
      activeSessions: z.array(z.string()),
      activeTerminals: z.array(z.string()),
      canRemove: z.boolean(),
    }),
  },
  /** New pairing code for this host. Only the machine itself may ask (loopback connections). */
  'host.pair': { params: z.object({}), result: PairingCode },
  /** The relay that lets devices on other networks reach this host. Loopback connections only. */
  'host.relay.get': { params: z.object({}), result: RelaySettings },
  /** Idle agent processes kept ready for new sessions; any connection may read them. */
  'host.warmPool.get': { params: z.object({}), result: WarmPoolSettings },
  /** Changes them; takes effect at once. Loopback connections only. */
  'host.warmPool.set': { params: WarmPoolChange, result: WarmPoolSettings },
  'host.mcpGateway.get': { params: z.object({}), result: McpGatewaySettings },
  'host.mcpGateway.set': {
    params: z.object({
      url: z.string().nullable(),
      secret: z.string().optional(),
      allowApprovals: z.boolean().optional(),
      allowProjectRead: z.boolean().optional(),
    }),
    result: McpGatewaySettings,
  },
  /** Sets (an ordinary address such as relay.example.com) or clears (null) the relay; takes effect at once. */
  'host.relay.set': {
    params: z.object({
      url: z.string().nullable(),
      /** The relay's password: leave out to keep the current one, empty or null to remove it. */
      password: z.string().nullable().optional(),
      /** Upload anonymous speed measurements to the relay. Leave out to keep it as it is. */
      telemetry: z.boolean().optional(),
    }),
    result: RelaySettings,
  },
  /**
   * What the host counts about itself: sessions by status, open requests, storage size, uptime.
   * Any paired device may read it; the same numbers are served at `GET /metrics`.
   */
  'host.stats': { params: z.object({}), result: HostStats },
  /**
   * Housekeeping: deletes sessions whose last activity is older than `days` (never busy, waiting,
   * or pinned ones), optionally their worktrees, unreferenced old attachments, and vacuums the
   * event log. `dryRun` only reports what would happen. Loopback and paired devices may run it.
   */
  'host.gc': {
    params: z.object({
      days: z.number().int().min(1).max(3650).optional(),
      dryRun: z.boolean().optional(),
      /** Also remove the worktrees of removed sessions (only when they are clean). */
      worktrees: z.boolean().optional(),
      /** Reclaim database space after the deletions (default on). */
      vacuum: z.boolean().optional(),
    }),
    result: GcReport,
  },
  /**
   * Speed measurements from a client. The host passes them to the relay when the user turned that
   * on; `accepted: false` tells the client to stop sending.
   */
  'telemetry.report': {
    params: z.object({
      platform: MetricPlatform,
      records: z.array(MetricRecord).max(200),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  /** Paired devices, and removal of one (its token stops working). Loopback connections only. */
  'devices.list': { params: z.object({}), result: z.array(Device) },
  'devices.revoke': {
    params: z.object({ id: z.string() }),
    result: z.object({ revoked: z.boolean() }),
  },
  /** Tailscale peers as seen from this machine, with a probe for BeddCode hosts among them. */
  'tailnet.peers': {
    params: z.object({ port: z.number().int().min(1).max(65535).optional() }),
    result: TailnetStatus,
  },
  'terminals.create': {
    params: z.object({
      cwd: z.string(),
      cols: z.number().int().min(2).max(500).optional(),
      rows: z.number().int().min(2).max(200).optional(),
      /** A command to run in the shell (a project script), and the tab's name for it. */
      command: z.string().trim().min(1).max(2000).optional(),
      title: z.string().trim().min(1).max(40).optional(),
      /** The project script: reuse a running instance in this folder. */
      scriptId: z.string().min(1).max(64).optional(),
    }),
    result: TerminalInfo,
  },
  'terminals.list': {
    params: z.object({ cwd: z.string().optional() }),
    result: z.array(TerminalInfo),
  },
  /**
   * Preview URLs detected in terminal output (dev servers printing their port), across all
   * terminals, so any client can offer "Open preview".
   */
  'previews.list': { params: z.object({}), result: z.array(PreviewEntry) },
  /** Ends the shell (if running) and forgets the terminal. */
  'terminals.close': { params: z.object({ id: z.string() }), result: z.object({}) },
  /** Names the tab; an empty name goes back to the default. Every connected client sees it. */
  'terminals.rename': {
    params: z.object({ id: z.string(), name: z.string().max(200) }),
    result: TerminalInfo,
  },
  /** Lets the user type into an agent terminal (it starts read-only). */
  'terminals.takeOver': { params: z.object({ id: z.string() }), result: TerminalInfo },
  /** Folder contents; `dir` is relative to `cwd` (empty for the root). Folders first. */
  'files.list': {
    params: z.object({ cwd: z.string(), dir: z.string().optional() }),
    result: z.object({ entries: z.array(FileEntry) }),
  },
  'files.read': { params: z.object({ cwd: z.string(), path: z.string() }), result: FileContent },
  /**
   * Which of these paths (relative to `cwd`, or absolute) are files or folders inside `cwd`; each
   * answer is the path relative to it, or null. Used to make paths in text clickable.
   */
  'files.locate': {
    params: z.object({ cwd: z.string(), paths: z.array(z.string().max(1024)).max(200) }),
    result: z.object({
      found: z.array(z.object({ path: z.string(), type: z.enum(['file', 'dir']) }).nullable()),
    }),
  },
  /** An address for showing an image, video or audio file; null when the file is not one. */
  'files.media': {
    params: z.object({ cwd: z.string(), path: z.string() }),
    result: FileMedia.nullable(),
  },
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
      /** Continue in the exact working directory of an existing session. */
      handoffFrom: z.string().optional(),
      handoffReason: z.string().max(1000).optional(),
      /** Defaults to the server's working directory for older clients. */
      cwd: z.string().optional(),
      /** Use a persistent session folder managed by the host, without joining a project. */
      projectless: z.boolean().optional(),
      title: z.string().optional(),
      permissionMode: z.string().optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      /** The agent's own settings to apply as the session starts (see agents.preview). */
      config: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
      /** Where the agent works. Defaults to the folder itself. */
      workspace: z
        .object({
          mode: z.enum(['local', 'worktree']),
          /** Branch a new worktree starts from; defaults to the repository's main branch. */
          baseBranch: z.string().optional(),
          /** Name for the new worktree's branch; generated when omitted. */
          branch: z.string().optional(),
          /** Name for the worktree's folder under .wt; follows the branch name when omitted. */
          name: z.string().max(80).optional(),
          /** With mode "local": a new branch to create from baseBranch and check out in the folder. */
          newBranch: z.string().max(200).optional(),
        })
        .optional(),
      /** Let the agent start and manage sessions of its own (BeddCode's agent tools). */
      agentTools: z.boolean().optional(),
      /** Let the agent use the desktop app's browser pane (BeddCode's browser tools). */
      browserTools: z.boolean().optional(),
      /** Let the agent read and draw on the host's design canvases (BeddCode's design tools). */
      designTools: z.boolean().optional(),
      /** Let the agent operate the host's desktop (BeddCode's computer tools). */
      computerTools: z.boolean().optional(),
      /** Let the agent read the user's Linear issues (BeddCode's Linear tools). */
      linearTools: z.boolean().optional(),
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
  'attachments.inspect': {
    params: z.object({ ids: z.array(z.string().max(200)).max(200) }),
    result: z.array(
      z.object({ id: z.string(), name: z.string(), size: z.number().int() }).nullable(),
    ),
  },
  'attachments.read': {
    params: z.object({ id: z.string().optional(), path: z.string().optional() }),
    result: z.object({
      id: z.string(),
      name: z.string(),
      size: z.number().int(),
      dataBase64: z.string(),
    }),
  },
  'files.saveCopy': {
    params: z.object({
      cwd: z.string(),
      path: z.string().min(1),
      content: z.string().max(2 * 1024 * 1024),
    }),
    result: z.object({}),
  },
  /** Snapshot a file from the workspace on its host, including images and other binary files. */
  'attachments.fromFile': {
    params: z.object({ cwd: z.string(), path: z.string().min(1) }),
    result: z.object({ id: z.string(), name: z.string(), size: z.number().int() }),
  },
  /**
   * An address for showing an attached image. Name it by `id` (before sending) or by the stored
   * `path` a sent message carries; null when it is not a viewable media file.
   */
  'attachments.media': {
    params: z.object({ id: z.string().optional(), path: z.string().optional() }),
    result: FileMedia.nullable(),
  },
  /**
   * Sends a message. While the agent is busy it is steered into the running turn when the agent
   * supports that, otherwise queued for the next turn (mode 'queue' always queues).
   */
  'sessions.prompt': {
    params: z.object({
      sessionId: z.string(),
      text: z.string(),
      /** Ids returned by attachments.upload. A prompt needs text or at least one attachment. */
      attachments: z.array(z.string()).optional(),
      mode: z.enum(['auto', 'queue']).optional(),
      /**
       * Chosen by the client, the same for every attempt at one message: the host sends a message
       * it already has only once and answers the repeat like the first.
       */
      clientMessageId: z.string().max(200).optional(),
    }),
    result: z.object({
      state: z.enum(['started', 'steered', 'queued']),
      queueId: z.string().optional(),
    }),
  },
  /** Drops a queued message, or sends it into the running turn right away ('steer'). */
  'sessions.dequeue': {
    params: z.object({
      sessionId: z.string(),
      queueId: z.string(),
      action: z.enum(['cancel', 'steer']),
    }),
    result: z.object({}),
  },
  'sessions.queue.edit': {
    params: z.object({
      sessionId: z.string(),
      queueId: z.string(),
      text: z.string().max(100_000),
      expectedText: z.string(),
    }),
    result: z.object({}),
  },
  'sessions.queue.move': {
    params: z.object({
      sessionId: z.string(),
      queueId: z.string(),
      direction: z.enum(['up', 'down']),
    }),
    result: z.object({}),
  },
  /** Answers a question.requested event; omit answers to dismiss the question. */
  'sessions.answer': {
    params: z.object({
      sessionId: z.string(),
      requestId: z.string(),
      answers: z.record(z.string(), z.array(z.string())).optional(),
    }),
    result: z.object({}),
  },
  /** Switches the model (and reasoning effort) a session uses from its next message on. */
  'sessions.setModel': {
    params: z.object({
      sessionId: z.string(),
      /** Omit to go back to the agent's default model. */
      model: z.string().optional(),
      effort: z.string().optional(),
    }),
    result: z.object({}),
  },
  /** Changes one of the agent's own settings for a session (see session.config events). */
  'sessions.setConfig': {
    params: z.object({
      sessionId: z.string(),
      optionId: z.string(),
      value: z.union([z.string(), z.boolean()]),
    }),
    result: z.object({}),
  },
  /** Starts a new session that continues an existing one, optionally only its first N turns. */
  'sessions.fork': {
    params: z.object({
      sessionId: z.string(),
      /** Keep the first N turns; omit to keep everything. */
      throughTurn: z.number().int().min(1).optional(),
      title: z.string().optional(),
      side: z.boolean().optional(),
    }),
    result: z.object({ sessionId: z.string() }),
  },
  /**
   * The modes, settings and commands an agent offers before any session exists (ACP agents report
   * them only when a session starts). The first answer may take a few seconds; later ones are cached.
   */
  'agents.preview': {
    params: z.object({
      instanceId: z.string(),
      cwd: z.string().optional(),
      refresh: z.boolean().optional(),
    }),
    result: AgentPreview,
  },
  'agents.inspect': {
    params: z.object({ id: z.string(), cwd: z.string().optional() }),
    result: z.object({
      command: z.string(),
      args: z.array(z.string()),
      executable: z.string(),
      cwd: z.string(),
      checkedAt: z.number(),
      protocolVersion: z.number(),
      name: z.string().optional(),
      version: z.string().optional(),
      authMethods: z.number(),
      features: z.record(z.string(), z.boolean()),
      raw: z.unknown().optional(),
      clientProfile: z.literal('restricted-diagnostic').optional(),
    }),
  },
  /** Conversations of an agent that were started outside BeddCode (or earlier), newest first. */
  'history.list': {
    params: z.object({ instanceId: z.string(), cwd: z.string().optional() }),
    result: z.array(HistoryEntry),
  },
  /** Brings one of those conversations into BeddCode as a session that can be continued. */
  'sessions.import': {
    params: z.object({
      instanceId: z.string(),
      providerSessionId: z.string(),
      cwd: z.string().optional(),
    }),
    result: z.object({ sessionId: z.string() }),
  },
  /** Slash commands and skills an agent offers in a folder, for the composer before a session exists. */
  'commands.list': {
    params: z.object({ instanceId: z.string(), cwd: z.string().optional() }),
    result: z.array(SlashCommand),
  },
  /** MCP servers as the agent's own CLI knows them. */
  'mcp.list': {
    params: z.object({ instanceId: z.string(), cwd: z.string().optional() }),
    result: z.array(McpServer),
  },
  'mcp.test': {
    params: z.object({
      url: z.string(),
      transport: z.enum(['http', 'sse']),
      headers: z.record(z.string(), z.string()).optional(),
      /** The server's name in a folder, to enforce that folder's MCP policy on the probe. */
      name: z.string().optional(),
      cwd: z.string().optional(),
    }),
    result: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        name: z.string(),
        version: z.string(),
        toolCount: z.number(),
        /** The tools the server offers, when it listed them. */
        tools: z.array(z.string()).optional(),
        /** Tools the project's policy blocks on this server. */
        blockedTools: z.array(z.string()).optional(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /** The MCP server policies this project has set: name → policy. */
  'mcp.policy.list': {
    params: z.object({ cwd: z.string().optional() }),
    result: z.array(z.object({ name: z.string(), policy: McpServerPolicy })),
  },
  /** Sets or clears (null) one server's policy for the project containing `cwd`. */
  'mcp.policy.set': {
    params: z.object({
      cwd: z.string().optional(),
      name: z.string().trim().min(1).max(120),
      policy: McpServerPolicy.nullable(),
    }),
    result: z.object({ name: z.string(), policy: McpServerPolicy.nullable() }),
  },
  'mcp.overview': {
    params: z.object({ cwd: z.string().optional() }),
    result: z.object({
      servers: z.array(
        z.object({
          name: z.string(),
          mismatch: z.boolean(),
          agents: z.array(
            z.object({ instanceId: z.string(), label: z.string(), server: McpServer }),
          ),
        }),
      ),
      errors: z.array(z.object({ instanceId: z.string(), label: z.string(), error: z.string() })),
    }),
  },
  'mcp.copy': {
    params: z.object({ instanceId: z.string(), name: z.string(), cwd: z.string().optional() }),
    result: z.array(
      z.object({
        instanceId: z.string(),
        label: z.string(),
        status: z.enum(['copied', 'skipped', 'failed']),
        error: z.string().optional(),
      }),
    ),
  },
  'mcp.add': {
    params: z.object({
      instanceId: z.string(),
      cwd: z.string().optional(),
      server: McpServerInput,
    }),
    result: z.object({}),
  },
  'mcp.remove': {
    params: z.object({
      instanceId: z.string(),
      cwd: z.string().optional(),
      name: z.string(),
      scope: z.string().optional(),
    }),
    result: z.object({}),
  },
  'session.switchAgent': {
    params: z.object({
      sessionId: z.string(),
      instanceId: z.string(),
      model: z.string().optional(),
      stop: z.boolean().optional(),
      pendingMessage: z.string().optional(),
      handoff: z.string().max(100_000).optional(),
      preview: z.boolean().optional(),
    }),
    result: z.object({ ok: z.boolean(), draft: z.string(), error: z.string().optional() }),
  },
  'sessions.interrupt': {
    /** `includeChildren` also stops the sessions this one's agent started. */
    params: z.object({ sessionId: z.string(), includeChildren: z.boolean().optional() }),
    result: z.object({}),
  },
  'sessions.interrupted': {
    params: z.object({}),
    result: z.array(
      z.object({
        sessionId: z.string(),
        turnId: z.string().optional(),
        at: z.number(),
        message: z.string(),
      }),
    ),
  },
  'sessions.resumeInterrupted': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({}),
  },
  'sessions.dismissInterrupted': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({}),
  },
  /**
   * What a session is doing on the desktop, for the Desktop pane: its latest window picture (left out
   * when `since` is already the newest), whether the user holds the controls, and its last actions.
   */
  'computer.view': {
    params: z.object({ sessionId: z.string(), since: z.number().optional() }),
    result: z.object({
      /** The session may use the computer. */
      enabled: z.boolean(),
      /** The user has taken over: the agent's computer calls wait. */
      paused: z.boolean(),
      /** This session holds the desktop right now. */
      active: z.boolean(),
      /** When the picture was taken; 0 when there is none yet. */
      at: z.number(),
      app: z.string().optional(),
      title: z.string().optional(),
      image: z.object({ data: z.string(), mime: z.string() }).optional(),
      actions: z.array(z.string()),
    }),
  },
  /** The user takes the controls from the agent (`paused`) or hands them back. */
  'computer.control': {
    params: z.object({ sessionId: z.string(), paused: z.boolean() }),
    result: z.object({ paused: z.boolean() }),
  },
  'sessions.rename': {
    params: z.object({ sessionId: z.string(), title: z.string().trim().min(1).max(120) }),
    result: z.object({}),
  },
  'sessions.notes.get': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({ text: z.string(), version: z.number().int() }),
  },
  'sessions.notes.set': {
    params: z.object({
      sessionId: z.string(),
      text: z.string().max(100_000),
      expectedVersion: z.number().int().nonnegative(),
      operationId: z.string().uuid().optional(),
    }),
    result: z.object({ text: z.string(), version: z.number().int() }),
  },
  'sessions.setBoardStage': {
    params: z.object({
      sessionId: z.string(),
      stage: z.enum(['pending', 'in-progress', 'review', 'done']),
    }),
    result: z.object({}),
  },
  'sessions.notes.receipt': {
    params: z.object({ sessionId: z.string(), operationId: z.string().uuid() }),
    result: z.object({
      saved: z.object({ text: z.string(), version: z.number().int() }).nullable(),
    }),
  },
  /** Moves a session into the sidebar's Done section, or back out of it. */
  'sessions.setDone': {
    params: z.object({ sessionId: z.string(), done: z.boolean() }),
    result: z.object({}),
  },
  /** Removes a session and its history from the host. The folder and any worktree are kept. */
  'sessions.delete': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({}),
  },
  /** Pins a session to the top of the sidebar, or unpins it. */
  'sessions.setPinned': {
    params: z.object({ sessionId: z.string(), pinned: z.boolean() }),
    result: z.object({}),
  },
  /** Marks a session as waiting on the user (with an optional note and reminder time), or clears it. */
  'sessions.setWaiting': {
    params: z.object({
      sessionId: z.string(),
      waiting: z.boolean(),
      note: z.string().trim().max(280).optional(),
      remindAt: z.number().optional(),
    }),
    result: z.object({}),
  },
  /** One file's diff for a finished turn (see the `turn.changes` event), by that turn's `after`. */
  'sessions.turnDiff': {
    params: z.object({ sessionId: z.string(), after: z.string(), path: z.string() }),
    result: GitDiff,
  },
  /**
   * Puts the files the latest turn changed back the way they were before it. Only while the
   * agent is idle and nothing changed in the folder since the turn ended.
   */
  'sessions.undoTurn': {
    params: z.object({ sessionId: z.string(), after: z.string() }),
    result: z.object({ restored: z.number().int() }),
  },
  'sessions.setMode': {
    params: z.object({ sessionId: z.string(), modeId: z.string() }),
    result: z.object({}),
  },
  'sessions.approve': {
    params: z.object({ sessionId: z.string(), requestId: z.string(), optionId: z.string() }),
    result: z.object({}),
  },
  /** Prompts the host runs on a timer, with their recent runs. */
  'schedules.list': {
    params: z.object({}),
    result: z.object({ schedules: z.array(Schedule), runs: z.array(ScheduleRun) }),
  },
  'schedules.save': { params: ScheduleInput, result: Schedule },
  'schedules.remove': {
    params: z.object({ id: z.string() }),
    result: z.object({ removed: z.boolean() }),
  },
  'schedules.setPaused': {
    params: z.object({ id: z.string(), paused: z.boolean() }),
    result: Schedule,
  },
  /** Fires a schedule now, whatever its timer says (still skipped while a run is going). */
  'schedules.runNow': { params: z.object({ id: z.string() }), result: ScheduleRun },
  'schedules.skipNext': { params: z.object({ id: z.string() }), result: Schedule },
  /** Turns a cron expression or interval into its next few times, to check it before saving. */
  'schedules.preview': {
    params: z.object({
      trigger: ScheduleInput.shape.trigger,
      count: z.number().int().min(1).max(10).optional(),
    }),
    result: z.object({ times: z.array(z.number().int()), error: z.string().optional() }),
  },
  'alerts.settings': {
    params: z.object({}),
    result: z.object({
      settings: AlertSettings,
      devices: z.array(PushRegistration.omit({ token: true }).extend({ tokenTail: z.string() })),
      recent: z.array(SentAlert),
    }),
  },
  'alerts.setSettings': {
    params: z.object({
      ntfyUrl: z.string().url().nullable().optional(),
      ntfyEvents: AlertEvents.optional(),
    }),
    result: AlertSettings,
  },
  /** Sends a test alert everywhere alerts go. */
  'alerts.test': { params: z.object({}), result: SentAlert },
  /** A phone asks for push alerts, or changes which ones it wants. Tied to its pairing. */
  'push.register': {
    params: z.object({
      token: z.string().min(10).max(300),
      deviceName: z.string().max(80).optional(),
      platform: z.enum(['android', 'ios']).optional(),
      events: AlertEvents,
    }),
    result: z.object({}),
  },
  'push.unregister': {
    params: z.object({ token: z.string() }),
    result: z.object({ removed: z.boolean() }),
  },
  /** Design canvases kept on the host. Saving tells every other client with a `design.changed` frame. */
  'design.list': { params: z.object({}), result: z.object({ designs: z.array(DesignSummary) }) },
  'design.get': { params: z.object({ id: z.string() }), result: Design },
  'design.create': { params: z.object({ name: z.string().max(120).optional() }), result: Design },
  'design.save': {
    params: z.object({
      id: z.string(),
      project: DesignProject,
      /** Names the saving client, so it can ignore the change frame its own save causes. */
      origin: z.string().max(80).optional(),
    }),
    result: DesignSummary,
  },
  'design.rename': {
    params: z.object({ id: z.string(), name: z.string().min(1).max(120) }),
    result: DesignSummary,
  },
  'design.delete': {
    params: z.object({ id: z.string() }),
    result: z.object({ removed: z.boolean() }),
  },
  /** Gives the host the Linear API key connected in the app, so agents with Linear tools can use it. Null disconnects. */
  'linear.setKey': {
    params: z.object({ key: z.string().max(500).nullable() }),
    result: z.object({ connected: z.boolean() }),
  },
  /** What the host does in Linear by itself, with the connected key. */
  'linear.setSync': {
    params: z.object({
      /** File a Linear issue when a scheduled task fails. */
      fileFailedRuns: z.boolean(),
      /** The team that issue is filed in. */
      teamId: z.string().max(100).optional(),
    }),
    result: z.object({ fileFailedRuns: z.boolean(), teamId: z.string().optional() }),
  },
  /** The Telegram bot that lets the user message agents from a chat. */
  'telegram.status': { params: z.object({}), result: TelegramStatus },
  'telegram.configure': {
    params: z.object({
      /** A BotFather token; null removes it. */
      token: z.string().max(200).nullable().optional(),
      /** Opens a fresh one-time code to send the bot as `/pair <code>`. */
      newPairCode: z.boolean().optional(),
      /** Forgets every paired chat. */
      unpair: z.boolean().optional(),
    }),
    result: TelegramStatus,
  },
} as const

export type RpcMethodName = keyof typeof RpcMethods
export type RpcParams<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['params']>
export type RpcResult<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['result']>
