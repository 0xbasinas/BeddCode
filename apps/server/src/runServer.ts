import path from 'node:path'
import { AcpAgentStore, AcpRegistry, createAcpAdapter } from '@beddcode/provider-acp'
import { createClaudeAdapter } from '@beddcode/provider-claude'
import { createCodexAdapter } from '@beddcode/provider-codex'
import { createFakeAdapter, type ProviderAdapter } from '@beddcode/provider-core'
import { createLogger } from '@beddcode/shared'
import { AgentCatalog } from './agents/catalog.ts'
import { PreviewCache } from './agents/previews.ts'
import { AttachmentStore } from './attachments/store.ts'
import { PairingManager } from './auth/pairing.ts'
import { TokenStore } from './auth/tokens.ts'
import { isLoopbackHost, type ServerConfig } from './config.ts'
import { dataHome, loadHostId } from './hostIdentity.ts'
import { TailscaleService } from './network/tailscale.ts'
import { SessionManager } from './sessions/sessionManager.ts'
import { recoverInterruptedTurns } from './sessions/recovery.ts'
import { EventStore } from './store/eventStore.ts'
import { startServer } from './transport/server.ts'
import { FileService } from './files/files.ts'
import { FileWatchers } from './files/watcher.ts'
import { TerminalManager } from './terminals/manager.ts'
import { GitService } from './workspace/git.ts'
import { GithubService } from './workspace/github.ts'
import { ProjectStore } from './workspace/projects.ts'

/** Starts the host and keeps running until SIGINT/SIGTERM. */
export async function runServer(config: ServerConfig): Promise<void> {
  const log = createLogger('server')
  const home = dataHome()

  const acpStore = new AcpAgentStore(path.join(home, 'acp-agents.json'))
  const adapters: ProviderAdapter[] = [
    createClaudeAdapter({ log: createLogger('claude') }),
    createCodexAdapter({ log: createLogger('codex') }),
    createAcpAdapter({ store: acpStore, log: createLogger('acp') }),
  ]
  // "advanced" adds steering, plans, questions, forks and history to the scripted agent.
  const fake = process.env.BEDDCODE_FAKE_PROVIDER
  if (fake === '1' || fake === 'advanced') {
    adapters.push(createFakeAdapter({ advanced: fake === 'advanced', delayMs: 120 }))
  }

  const store = new EventStore(path.join(home, 'beddcode.db'))
  recoverInterruptedTurns(store)
  const attachments = new AttachmentStore(path.join(home, 'attachments'))
  const git = new GitService()
  const workspace = {
    git,
    github: new GithubService(),
    projects: new ProjectStore(path.join(home, 'projects.json'), git),
    terminals: new TerminalManager(),
    files: new FileService(),
  }
  const watchers = new FileWatchers()
  const sessions = new SessionManager({
    store,
    attachments,
    git,
    adapters,
    log,
    defaultCwd: process.cwd(),
    previews: new PreviewCache(path.join(home, 'agent-previews.json')),
  })
  const agents = new AgentCatalog(
    acpStore,
    new AcpRegistry(),
    () => sessions.invalidateDetection(),
    {
      root: path.join(home, 'agents'),
    },
  )

  const server = await startServer({
    port: config.port,
    host: config.host,
    guard: config.guard,
    hostId: loadHostId(home),
    defaultCwd: process.cwd(),
    store,
    sessions,
    agents,
    attachments,
    workspace,
    watchers,
    tokens: new TokenStore(path.join(home, 'auth.json')),
    pairing: new PairingManager(),
    tailscale: new TailscaleService(),
    log,
  })
  log.info(`listening on ${config.host}:${server.port} (data: ${home})`)
  if (!isLoopbackHost(config.host)) {
    log.info(
      `reachable from other machines: ${config.guard.allowLan ? 'tailnet and local network' : 'tailnet only'}, ` +
        `paired devices only. Run "pair" on this machine to add one.`,
    )
  }

  const shutdown = () =>
    void sessions
      .close()
      .then(() => {
        workspace.terminals.shutdown()
        return watchers.closeAll()
      })
      .then(() => server.close())
      .then(() => {
        store.close()
        process.exit(0)
      })
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
