import { existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  RpcMethods,
  type MetricPlatform,
  type MetricRecord,
  type RelaySettings,
  type McpGatewaySettings,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
} from '@beddcode/contracts'
import { buildPairLink } from '@beddcode/client-runtime/pairLink'
import type { PairingManager } from '../auth/pairing.ts'
import type { PeerClass } from '../auth/guard.ts'
import type { TokenStore } from '../auth/tokens.ts'
import type { TailscaleService } from '../network/tailscale.ts'
import type { AgentCatalog } from '../agents/catalog.ts'
import type { AttachmentStore } from '../attachments/store.ts'
import type { SessionManager } from '../sessions/sessionManager.ts'
import type { GitService } from '../workspace/git.ts'
import type { GithubService } from '../workspace/github.ts'
import type { ProjectStore } from '../workspace/projects.ts'
import { browseFolders } from '../workspace/folders.ts'
import { detectEditors, launchEditor, type DetectedEditor } from '../workspace/editors.ts'
import type { FileService } from '../files/files.ts'
import { mediaType } from '../files/media.ts'
import type { TerminalManager } from '../terminals/manager.ts'
import type { AlertService } from '../automation/alerts.ts'
import type { ComputerPane } from '../automation/index.ts'
import { previewTrigger } from '../automation/cron.ts'
import type { DesignStore } from '../design/designStore.ts'
import type { ScheduleService } from '../automation/schedules.ts'

type Handlers = {
  [M in RpcMethodName]: (params: RpcParams<M>, context: RpcContext) => Promise<RpcResult<M>>
}

/** Schedules, alerts and the agent tools. */
export interface AutomationServices {
  schedules: ScheduleService
  alerts: AlertService
  designs: DesignStore
  computer: ComputerPane
  linear: { setKey(key: string | null): boolean }
}

/** Everything that works on a session's folder: git, projects, shells and files. */
export interface WorkspaceServices {
  git: GitService
  github: GithubService
  projects: ProjectStore
  terminals: TerminalManager
  files: FileService
}

/** Validates params against the contract, then dispatches to the matching handler. */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The project's setup commands (installing dependencies...) run in a new worktree. */
export function runWorktreeSetup(
  sessions: SessionManager,
  workspace: Pick<WorkspaceServices, 'projects' | 'terminals'>,
  params: { cwd?: string; workspace?: { mode: string } },
  sessionId: string,
) {
  if (params.workspace?.mode !== 'worktree' || !params.cwd) return
  const info = sessions.sessionInfo(sessionId)
  if (!info) return
  for (const script of workspace.projects
    .scriptsFor(params.cwd)
    .filter((s) => s.runOnWorktreeCreate)) {
    workspace.terminals.create({
      cwd: info.cwd,
      command: script.command,
      title: script.name,
      scriptId: script.id,
    })
  }
}

/** Who may reach this host, and how new devices get in. */
export interface AccessServices {
  tokens: TokenStore
  pairing: PairingManager
  tailscale: TailscaleService
  /** The port this host listens on, probed on other tailnet machines. */
  port: () => number
  /** Addresses another device could reach this host on, and who it is, for pairing links. */
  reachable?: () => Promise<{ hostId: string; name: string; routes: string[]; relay?: string }>
  /** Reads and changes the relay this host is reachable through. */
  relay?: RelayControl
  mcpGateway?: {
    get(): McpGatewaySettings
    set(
      url: string | null,
      secret?: string,
      allowApprovals?: boolean,
      allowProjectRead?: boolean,
    ): Promise<McpGatewaySettings>
  }
  /** Where apps' speed measurements go (kept only while the owner has uploads switched on). */
  telemetry?: { report(platform: MetricPlatform, records: MetricRecord[]): boolean }
}

export interface RelayControl {
  get(): RelaySettings
  set(url: string | null, password?: string | null, telemetry?: boolean): Promise<RelaySettings>
}

/** What the router knows about the caller. */
export interface RpcContext {
  peer: PeerClass
  /** The paired device on the other end, once it has shown its token. */
  deviceId?: string
}

/** Managing who may connect is only for someone sitting at this machine. */
/** Installed editors, looked up again at most every 30 s (a lookup stats a few dozen paths). */
let editorCache: { at: number; editors: DetectedEditor[] } | undefined
function listEditors(fresh = false): DetectedEditor[] {
  if (fresh || !editorCache || Date.now() - editorCache.at > 30_000)
    editorCache = { at: Date.now(), editors: detectEditors() }
  return editorCache.editors
}

const LOOPBACK_ONLY: ReadonlySet<RpcMethodName> = new Set([
  'host.pair',
  'host.relay.get',
  'host.relay.set',
  'host.mcpGateway.get',
  'host.mcpGateway.set',
  'devices.list',
  'devices.revoke',
  'editors.open',
])

export function createRpcRouter(
  sessions: SessionManager,
  agents: AgentCatalog,
  attachments: AttachmentStore,
  workspace: WorkspaceServices,
  access: AccessServices,
  automation: AutomationServices,
) {
  const { git, github, projects, terminals, files } = workspace
  const { schedules, alerts, designs } = automation
  const handlers: Handlers = {
    'host.pair': async () => {
      const pair = access.pairing.create()
      const where = await access.reachable?.().catch(() => undefined)
      if (!where) return pair
      return {
        ...pair,
        link: buildPairLink({
          code: pair.code,
          name: where.name,
          hostId: where.hostId,
          routes: where.routes,
          relay: where.relay,
        }),
      }
    },
    'host.relay.get': async () => {
      if (!access.relay) throw new Error('This host does not support relays')
      return access.relay.get()
    },
    'host.mcpGateway.get': async () => {
      if (!access.mcpGateway) throw new Error('This host does not support the MCP gateway')
      return access.mcpGateway.get()
    },
    'host.mcpGateway.set': (p) => {
      if (!access.mcpGateway) throw new Error('This host does not support the MCP gateway')
      return access.mcpGateway.set(p.url, p.secret, p.allowApprovals, p.allowProjectRead)
    },
    'host.relay.set': (p) => {
      if (!access.relay) throw new Error('This host does not support relays')
      return access.relay.set(p.url, p.password, p.telemetry)
    },
    'telemetry.report': async (p) => ({
      accepted: access.telemetry?.report(p.platform, p.records) ?? false,
    }),
    'devices.list': async () => access.tokens.list(),
    'devices.revoke': async (p) => {
      alerts.forgetDevice(p.id)
      return { revoked: access.tokens.revoke(p.id) }
    },
    'tailnet.peers': (p) => access.tailscale.discover(p.port ?? access.port()),
    'providers.list': () => sessions.listProviders(),
    'agents.list': async () => agents.list(),
    'agents.add': (p) => agents.add(p),
    'agents.update': (p) => agents.update(p),
    'usage.summary': (p) => sessions.usageSummary(p.days),
    'usage.limits': () => sessions.usageLimits(),
    'agents.remove': (p) => agents.remove(p.id),
    'agents.registry': (p) => agents.searchRegistry(p.query),
    'projects.list': () => projects.list(),
    'projects.add': (p) => projects.add(p.path),
    'projects.remove': async (p) => ({ removed: projects.remove(p.path) }),
    'projects.initGit': (p) => projects.initGit(p.path),
    'projects.setScripts': (p) => projects.setScripts(p.path, p.scripts),
    'folders.browse': (p) => browseFolders(p.path, { showHidden: p.showHidden }),
    'git.info': (p) => git.info(p.cwd),
    'git.status': (p) => git.status(p.cwd),
    'git.diff': (p) => git.diff(p.cwd, p.path),
    'git.log': (p) => git.log(p.cwd),
    'git.branches': (p) => git.branches(p.cwd),
    'git.generate': (p) => sessions.generateGitText(p),
    'git.commit': (p) => git.commit(p.cwd, p.message, p.paths, p.push),
    'git.push': async (p) => {
      await git.push(p.cwd)
      return {}
    },
    'git.pr.get': (p) => github.pullRequest(p.cwd),
    'git.ci.report': (p) => github.ciReport(p.cwd),
    'git.gh.status': (p) => github.status(p.cwd),
    'git.pr.list': async (p) => ({ items: await github.list(p.cwd, p.filter, p.limit) }),
    'git.pr.view': (p) => github.view(p.cwd, p.number),
    'git.pr.act': (p) => github.act(p.cwd, p.number, p.do),
    'editors.list': async (_p, context) => ({
      editors: listEditors().map(({ id, label }) => ({ id, label })),
      canOpen: context.peer === 'loopback',
      platform: process.platform,
    }),
    'editors.open': async (p) => {
      const editor = listEditors(true).find((e) => e.id === p.editor)
      if (!editor) throw new Error('That editor is not installed on this computer')
      const cwd = path.resolve(p.cwd)
      if (!existsSync(cwd) || !statSync(cwd).isDirectory())
        throw new Error('That folder does not exist')
      if (p.path !== undefined) {
        const file = path.resolve(cwd, p.path)
        if (file !== cwd && !file.startsWith(cwd + path.sep))
          throw new Error('Only files inside the folder can be opened')
      }
      launchEditor(editor, { cwd, path: p.path, line: p.line, column: p.column })
      return { opened: true }
    },
    'git.pr.checkout': (p) => github.checkout(p.cwd, p.number, git, { worktree: p.worktree }),
    'git.pr.create': async (p) => {
      const info = await git.info(p.cwd)
      if (!info.branch || info.detached)
        throw new Error('Create a branch before opening a pull request')
      if (p.base && (p.base.trim() === info.branch || p.base.startsWith('-')))
        throw new Error('Choose a different base branch for the pull request')
      // The branch has to exist on GitHub before a pull request can be opened from it.
      await git.push(p.cwd)
      try {
        return { url: await github.createPullRequest(p.cwd, p) }
      } catch (err) {
        throw new Error(
          `Branch pushed, but pull request creation failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    'terminals.create': async (p) => {
      if (!isDirectory(p.cwd)) throw new Error(`Folder does not exist: ${p.cwd}`)
      return terminals.create(p)
    },
    'terminals.list': async (p) => terminals.list(p.cwd),
    'terminals.takeOver': async (p) => terminals.takeOver(p.id),
    'terminals.close': async (p) => {
      terminals.close(p.id)
      return {}
    },
    'files.list': async (p) => ({ entries: await files.list(p.cwd, p.dir) }),
    'files.read': (p) => files.read(p.cwd, p.path),
    'files.locate': async (p) => ({ found: await files.locate(p.cwd, p.paths) }),
    'files.media': (p) => files.mediaFor(p.cwd, p.path),
    'files.write': async (p) => ({
      mtime: await files.write(p.cwd, p.path, p.content, p.expectedMtime),
    }),
    'files.create': async (p) => {
      await files.create(p.cwd, p.path, p.type)
      return {}
    },
    'files.search': async (p) => ({ paths: await files.search(p.cwd, p.query) }),
    'worktrees.remove': async (p) => ({ removed: await sessions.removeWorktree(p.sessionId) }),
    'sessions.create': async (p) => {
      const created = await sessions.create(p)
      runWorktreeSetup(sessions, workspace, p, created.sessionId)
      return created
    },
    'attachments.upload': async (p) => {
      const saved = await attachments.save(p.name, Buffer.from(p.dataBase64, 'base64'))
      return { id: saved.id, name: saved.name, size: saved.size }
    },
    'attachments.fromFile': async (p) => {
      const saved = await attachments.save(p.path, await files.readAttachment(p.cwd, p.path))
      return { id: saved.id, name: saved.name, size: saved.size }
    },
    'attachments.media': async (p) => {
      const file = attachments.locate(p)
      const type = file ? mediaType(file) : undefined
      if (!file || !type) return null
      const info = await stat(file).catch(() => null)
      if (!info?.isFile()) return null
      return {
        url: `/media/${files.media.issue(file, type.mime)}`,
        kind: type.kind,
        mime: type.mime,
        size: info.size,
        mtime: info.mtimeMs,
      }
    },
    'sessions.prompt': (p) =>
      sessions.prompt(p.sessionId, p.text, p.attachments, p.mode, p.clientMessageId),
    'sessions.dequeue': async (p) => {
      await sessions.dequeue(p.sessionId, p.queueId, p.action)
      return {}
    },
    'sessions.answer': async (p) => {
      await sessions.answerQuestion(p.sessionId, p.requestId, p.answers)
      return {}
    },
    'sessions.setModel': async (p) => {
      await sessions.setModel(p.sessionId, p.model, p.effort)
      return {}
    },
    'sessions.setConfig': async (p) => {
      await sessions.setConfig(p.sessionId, p.optionId, p.value)
      return {}
    },
    'sessions.fork': (p) => sessions.fork(p),
    'sessions.import': (p) => sessions.importSession(p),
    'history.list': (p) => sessions.listHistory(p.instanceId, p.cwd),
    'commands.list': (p) => sessions.listCommands(p.instanceId, p.cwd),
    'agents.preview': (p) => sessions.previewAgent(p.instanceId, p.cwd),
    'mcp.list': async (p) => (await sessions.mcp(p.instanceId)).list(p.cwd),
    'mcp.add': async (p) => {
      await (await sessions.mcp(p.instanceId)).add(p.server, p.cwd)
      return {}
    },
    'mcp.remove': async (p) => {
      await (await sessions.mcp(p.instanceId)).remove(p.name, p.scope, p.cwd)
      return {}
    },
    'sessions.interrupt': async (p) => {
      await sessions.interrupt(p.sessionId, { includeChildren: p.includeChildren })
      return {}
    },
    'sessions.setPinned': async (p) => {
      sessions.setPinned(p.sessionId, p.pinned)
      return {}
    },
    'sessions.turnDiff': (p) => sessions.turnDiff(p.sessionId, p.after, p.path),
    'sessions.undoTurn': (p) => sessions.undoTurn(p.sessionId, p.after),
    'sessions.setDone': async (p) => {
      sessions.setDone(p.sessionId, p.done)
      return {}
    },
    'sessions.delete': async (p) => {
      await sessions.delete(p.sessionId)
      return {}
    },
    'sessions.rename': async (p) => {
      sessions.rename(p.sessionId, p.title)
      return {}
    },
    'sessions.setMode': async (p) => {
      await sessions.setMode(p.sessionId, p.modeId)
      return {}
    },
    'sessions.approve': async (p) => {
      await sessions.approve(p.sessionId, p.requestId, p.optionId)
      return {}
    },
    'design.list': async () => ({ designs: designs.list() }),
    'design.get': async (p) => {
      const design = designs.get(p.id)
      if (!design) throw new Error(`No design ${p.id}`)
      return design
    },
    'design.create': async (p) => designs.create(p.name),
    'design.save': async (p) => designs.save(p.id, p.project, p.origin),
    'design.rename': async (p) => designs.rename(p.id, p.name),
    'design.delete': async (p) => ({ removed: designs.remove(p.id) }),
    'computer.view': async (p) => automation.computer.view(p.sessionId, p.since),
    'computer.control': async (p) => ({
      paused: automation.computer.control(p.sessionId, p.paused),
    }),
    'linear.setKey': async (p) => ({ connected: automation.linear.setKey(p.key) }),
    'schedules.list': async () => schedules.list(),
    'schedules.save': async (p) => schedules.saveSchedule(p),
    'schedules.remove': async (p) => ({ removed: schedules.remove(p.id) }),
    'schedules.setPaused': async (p) => schedules.setPaused(p.id, p.paused),
    'schedules.runNow': (p) => schedules.runNow(p.id),
    'schedules.preview': async (p) => previewTrigger(p.trigger, Date.now(), p.count ?? 3),
    'alerts.settings': async () => alerts.view(),
    'alerts.setSettings': async (p) => alerts.setSettings(p),
    'alerts.test': () => alerts.test(),
    'push.register': async (p, context) => {
      alerts.register(context.deviceId, p)
      return {}
    },
    'push.unregister': async (p) => ({ removed: alerts.unregister(p.token) }),
  }

  return async function dispatch(
    method: string,
    params: unknown,
    context: RpcContext,
  ): Promise<unknown> {
    if (!Object.hasOwn(RpcMethods, method)) throw new Error(`unknown method: ${method}`)
    const name = method as RpcMethodName
    if (LOOPBACK_ONLY.has(name) && context.peer !== 'loopback') {
      throw new Error('This can only be done on the host machine itself')
    }
    const parsed = RpcMethods[name].params.parse(params ?? {})
    return (handlers[name] as (p: unknown, c: RpcContext) => Promise<unknown>)(parsed, context)
  }
}
