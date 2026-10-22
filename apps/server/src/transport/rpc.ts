import { statSync } from 'node:fs'
import { RpcMethods, type RpcMethodName, type RpcParams, type RpcResult } from '@beddcode/contracts'
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
import type { FileService } from '../files/files.ts'
import type { TerminalManager } from '../terminals/manager.ts'

type Handlers = {
  [M in RpcMethodName]: (params: RpcParams<M>) => Promise<RpcResult<M>>
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

/** Who may reach this host, and how new devices get in. */
export interface AccessServices {
  tokens: TokenStore
  pairing: PairingManager
  tailscale: TailscaleService
  /** The port this host listens on, probed on other tailnet machines. */
  port: () => number
}

/** What the router knows about the caller. */
export interface RpcContext {
  peer: PeerClass
}

/** Managing who may connect is only for someone sitting at this machine. */
const LOOPBACK_ONLY: ReadonlySet<RpcMethodName> = new Set([
  'host.pair',
  'devices.list',
  'devices.revoke',
])

export function createRpcRouter(
  sessions: SessionManager,
  agents: AgentCatalog,
  attachments: AttachmentStore,
  workspace: WorkspaceServices,
  access: AccessServices,
) {
  const { git, github, projects, terminals, files } = workspace
  const handlers: Handlers = {
    'host.pair': async () => access.pairing.create(),
    'devices.list': async () => access.tokens.list(),
    'devices.revoke': async (p) => ({ revoked: access.tokens.revoke(p.id) }),
    'tailnet.peers': (p) => access.tailscale.discover(p.port ?? access.port()),
    'providers.list': () => sessions.listProviders(),
    'agents.list': async () => agents.list(),
    'agents.add': (p) => agents.add(p),
    'agents.update': (p) => agents.update(p),
    'agents.remove': (p) => agents.remove(p.id),
    'agents.registry': (p) => agents.searchRegistry(p.query),
    'projects.list': () => projects.list(),
    'projects.add': (p) => projects.add(p.path),
    'projects.remove': async (p) => ({ removed: projects.remove(p.path) }),
    'projects.initGit': (p) => projects.initGit(p.path),
    'folders.browse': (p) => browseFolders(p.path, { showHidden: p.showHidden }),
    'git.info': (p) => git.info(p.cwd),
    'git.status': (p) => git.status(p.cwd),
    'git.diff': (p) => git.diff(p.cwd, p.path),
    'git.log': (p) => git.log(p.cwd),
    'git.branches': (p) => git.branches(p.cwd),
    'git.commit': (p) => git.commit(p.cwd, p.message, p.paths, p.push),
    'git.push': async (p) => {
      await git.push(p.cwd)
      return {}
    },
    'git.pr.get': (p) => github.pullRequest(p.cwd),
    'git.pr.create': async (p) => {
      // The branch has to exist on GitHub before a pull request can be opened from it.
      await git.push(p.cwd)
      return { url: await github.createPullRequest(p.cwd, p) }
    },
    'terminals.create': async (p) => {
      if (!isDirectory(p.cwd)) throw new Error(`Folder does not exist: ${p.cwd}`)
      return terminals.create(p)
    },
    'terminals.list': async (p) => terminals.list(p.cwd),
    'terminals.close': async (p) => {
      terminals.close(p.id)
      return {}
    },
    'files.list': async (p) => ({ entries: await files.list(p.cwd, p.dir) }),
    'files.read': (p) => files.read(p.cwd, p.path),
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
    'sessions.create': (p) => sessions.create(p),
    'attachments.upload': async (p) => {
      const saved = attachments.save(p.name, Buffer.from(p.dataBase64, 'base64'))
      return { id: saved.id, name: saved.name, size: saved.size }
    },
    'sessions.prompt': (p) => sessions.prompt(p.sessionId, p.text, p.attachments, p.mode),
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
      await sessions.interrupt(p.sessionId)
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
    return (handlers[name] as (p: unknown) => Promise<unknown>)(parsed)
  }
}
