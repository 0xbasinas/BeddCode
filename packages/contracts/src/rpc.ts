import { z } from 'zod'
import {
  GitBranch,
  GitDiff,
  GitInfo,
  GitLog,
  GitStatus,
  Project,
  ProjectScript,
  PullRequest,
  PullRequestDetail,
  PullRequestSummary,
  GithubStatus,
  PrFilter,
  PrAction,
} from './git.ts'
import { Device, MetricPlatform, MetricRecord, PairingCode, RelaySettings, TailnetStatus } from './hosts.ts'
import { ConfigOption, SlashCommand } from './events.ts'
import { PermissionModeOption, ProviderInstance } from './providers.ts'
import { FileContent, FileEntry, FileMedia, FolderListing, TerminalInfo } from './workspace.ts'
import { Design, DesignProject, DesignSummary } from './design.ts'
import { UsageLimits, UsageSummary } from './usage.ts'
import {
  AlertEvents,
  AlertSettings,
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

/** What an agent offers for a session that has not started yet. */
export const AgentPreview = z.object({
  modes: z.array(PermissionModeOption),
  currentModeId: z.string().optional(),
  config: z.array(ConfigOption),
  commands: z.array(SlashCommand),
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
  scope: z.enum(['user', 'project', 'local']).optional(),
})
export type McpServerInput = z.infer<typeof McpServerInput>

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
  /** Replaces the saved commands of an added folder. */
  'projects.setScripts': {
    params: z.object({ path: z.string().min(1), scripts: z.array(ProjectScript).max(20) }),
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
  'git.diff': { params: z.object({ cwd: z.string(), path: z.string() }), result: GitDiff },
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
  'git.pr.get': { params: z.object({ cwd: z.string() }), result: PullRequest.nullable() },
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
  /** Deletes the worktree a session was started in (its branch is kept). */
  'worktrees.remove': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({ removed: z.boolean() }),
  },
  /** New pairing code for this host. Only the machine itself may ask (loopback connections). */
  'host.pair': { params: z.object({}), result: PairingCode },
  /** The relay that lets devices on other networks reach this host. Loopback connections only. */
  'host.relay.get': { params: z.object({}), result: RelaySettings },
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
      /** A command to type into the new shell (a project script), and the tab's name for it. */
      command: z.string().trim().min(1).max(2000).optional(),
      title: z.string().trim().min(1).max(40).optional(),
      /** The project script: an earlier terminal of it in this folder is closed and replaced. */
      scriptId: z.string().min(1).max(64).optional(),
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
        })
        .optional(),
      /** Let the agent start and manage sessions of its own (BeddCode's agent tools). */
      agentTools: z.boolean().optional(),
      /** Let the agent use the desktop app's browser pane (BeddCode's browser tools). */
      browserTools: z.boolean().optional(),
      /** Let the agent read and draw on the host's design canvases (BeddCode's design tools). */
      designTools: z.boolean().optional(),
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
  /** Snapshot a file from the workspace on its host, including images and other binary files. */
  'attachments.fromFile': {
    params: z.object({ cwd: z.string(), path: z.string().min(1) }),
    result: z.object({ id: z.string(), name: z.string(), size: z.number().int() }),
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
    }),
    result: z.object({ sessionId: z.string() }),
  },
  /**
   * The modes, settings and commands an agent offers before any session exists (ACP agents report
   * them only when a session starts). The first answer may take a few seconds; later ones are cached.
   */
  'agents.preview': {
    params: z.object({ instanceId: z.string(), cwd: z.string().optional() }),
    result: AgentPreview,
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
  'sessions.interrupt': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({}),
  },
  'sessions.rename': {
    params: z.object({ sessionId: z.string(), title: z.string().trim().min(1).max(120) }),
    result: z.object({}),
  },
  /** Moves a session into the sidebar's Done section, or back out of it. */
  'sessions.setDone': {
    params: z.object({ sessionId: z.string(), done: z.boolean() }),
    result: z.object({}),
  },
  /** Pins a session to the top of the sidebar, or unpins it. */
  'sessions.setPinned': {
    params: z.object({ sessionId: z.string(), pinned: z.boolean() }),
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
} as const

export type RpcMethodName = keyof typeof RpcMethods
export type RpcParams<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['params']>
export type RpcResult<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['result']>
