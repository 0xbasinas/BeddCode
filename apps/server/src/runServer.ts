import os from 'node:os'
import path from 'node:path'
import { AcpAgentStore, AcpRegistry, createAcpAdapter } from '@beddcode/provider-acp'
import { createClaudeAdapter } from '@beddcode/provider-claude'
import { createCodexAdapter } from '@beddcode/provider-codex'
import { createFakeAdapter, type ProviderAdapter } from '@beddcode/provider-core'
import type { RelaySettings } from '@beddcode/contracts'
import {
  createLogger,
  killAllChildren,
  reapOrphans,
  recordChildrenIn,
  runningChildren,
} from '@beddcode/shared'
import { acquireHostLock, listenError } from './hostLock.ts'
import { AgentCatalog } from './agents/catalog.ts'
import { PreviewCache } from './agents/previews.ts'
import { AttachmentStore } from './attachments/store.ts'
import { PairingManager } from './auth/pairing.ts'
import { TokenStore } from './auth/tokens.ts'
import {
  isLoopbackHost,
  normalizeRelayUrl,
  readConfigFile,
  writeConfigFile,
  type ServerConfig,
} from './config.ts'
import { dataHome, loadHostId, loadRelayKey } from './hostIdentity.ts'
import { RelayAgent } from './relay/agent.ts'
import { Telemetry, hostLabel } from './telemetry/telemetry.ts'
import { newRelayKey } from '@beddcode/client-runtime/relayCrypto'
import { buildRelayRoute } from '@beddcode/client-runtime/relaySocket'
import { findWebRoot } from './web/static.ts'
import { TailscaleService } from './network/tailscale.ts'
import { reachableRoutes } from './network/reachable.ts'
import { SessionManager } from './sessions/sessionManager.ts'
import { recoverInterruptedTurns } from './sessions/recovery.ts'
import { openEventStore } from './store/eventStore.ts'
import { startServer } from './transport/server.ts'
import { FileService } from './files/files.ts'
import { FileWatchers } from './files/watcher.ts'
import { TerminalManager } from './terminals/manager.ts'
import { GitService } from './workspace/git.ts'
import { GithubService } from './workspace/github.ts'
import { ProjectStore } from './workspace/projects.ts'
import { createShutdown, watchForCrashes } from './shutdown.ts'
import type { AgentTools } from './automation/agentTools.ts'
import { createAutomation } from './automation/index.ts'
import { GatewayControl } from './mcpGateway/control.ts'

/** Starts the host and keeps running until SIGINT/SIGTERM. */
export async function runServer(config: ServerConfig): Promise<void> {
  const log = createLogger('server')
  const home = dataHome()
  // One host per data folder; a second one says so instead of corrupting the first one's state.
  const lock = await acquireHostLock(home, config.port, { log })
  process.on('exit', () => lock.release())
  // Agents a killed host left running (nothing ran its exit handlers): end them, then keep the
  // list for this host, so the next start can do the same.
  const ledger = path.join(home, 'children.json')
  await reapOrphans(ledger, log).catch((err: unknown) =>
    log.warn('could not check for agents a previous host left running', err),
  )
  recordChildrenIn(ledger)

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

  const store = openEventStore(path.join(home, 'beddcode.db'))
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
  const watchers = new FileWatchers((cwd) => workspace.files.invalidate(cwd))
  // Filled in once the host listens: the agent tools' bridge calls back on this port.
  let port = config.port
  let agentTools: AgentTools | undefined
  const sessions = new SessionManager({
    agentToolServers: (sessionId) => agentTools?.serversFor(sessionId) ?? [],
    store,
    attachments,
    git,
    adapters,
    log,
    defaultCwd: process.cwd(),
    sessionRoot: path.join(home, 'sessions'),
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

  const hostId = loadHostId(home)
  const automation = createAutomation({
    home,
    hostId,
    sessions,
    store,
    workspace,
    port: () => port,
    browserImageDir: path.join(attachments.root, 'browser'),
  })
  agentTools = automation.agentTools
  const { schedules, alerts, designs } = automation
  const tokens = new TokenStore(path.join(home, 'auth.json'))
  tokens.onRevoke((deviceId) => alerts.forgetDevice(deviceId))

  const tailscale = new TailscaleService()
  // The relay can be switched on, changed or off while the host runs (see `relayControl`).
  let relayUrl = config.relayUrl
  let relayPassword = config.relayPassword
  let telemetryOn = config.telemetry ?? false
  const telemetry = new Telemetry({
    target: () =>
      relayUrl && relayPassword ? { url: relayUrl, password: relayPassword } : undefined,
    enabled: () => telemetryOn,
    hostLabel: hostLabel(hostId),
    log,
  })
  let relayRoute: string | undefined
  let relay: RelayAgent | undefined
  const relaySettings = (): RelaySettings => ({
    url: relayUrl,
    passwordSet: !!relayPassword,
    telemetry: telemetryOn,
    status: relay && relay.status !== 'stopped' ? relay.status : 'off',
  })
  const relayControl = {
    get: relaySettings,
    // A password of undefined keeps the one in use; an empty one removes it.
    async set(
      input: string | null,
      password?: string | null,
      telemetryChoice?: boolean,
    ): Promise<RelaySettings> {
      const next = input === null || input.trim() === '' ? undefined : normalizeRelayUrl(input)
      if (password !== undefined) relayPassword = password?.trim() || undefined
      if (telemetryChoice !== undefined) telemetryOn = telemetryChoice
      writeConfigFile({
        ...readConfigFile(),
        relayUrl: next,
        relayPassword: next ? relayPassword : undefined,
        telemetry: telemetryOn,
      })
      relayUrl = next
      relay?.stop()
      relay = undefined
      relayRoute = undefined
      if (next) startRelay(next)
      return relaySettings()
    },
  }
  // Devices on other networks reach this host through the relay, which this host dials out to.
  const startRelay = (url: string) => {
    const key = loadRelayKey(home, newRelayKey)
    relayRoute = buildRelayRoute(url, key)
    relay = new RelayAgent({
      url,
      key,
      password: relayPassword,
      attach: (socket) => server.attach(socket, 'other'),
      log,
    })
    relay.start()
  }
  const mcpGateway = new GatewayControl({ home, sessions, store, log }, async () =>
    (await workspace.projects.list()).map((p) => p.path),
  )
  let server: Awaited<ReturnType<typeof startServer>>
  try {
    server = await startServer({
      port: config.port,
      host: config.host,
      guard: config.guard,
      hostId,
      defaultCwd: process.cwd(),
      webRoot: findWebRoot(),
      store,
      sessions,
      agents,
      attachments,
      workspace,
      watchers,
      tokens,
      pairing: new PairingManager(),
      tailscale,
      reachable: async () => ({
        hostId,
        name: os.hostname(),
        relay: relayRoute,
        routes: await reachableRoutes({
          tailscale,
          port,
          listenHost: config.host,
          allowLan: config.guard.allowLan,
        }),
      }),
      relay: relayControl,
      mcpGateway,
      telemetry,
      telemetryRecorder: (name, value, tags) => telemetry.record(name, value, tags),
      automation: { schedules, alerts, designs, computer: automation.computerPane },
      agentTools,
      browser: automation.browser,
      designLink: automation.designLink,
      log,
    })
  } catch (err) {
    // Nothing started yet: let go of what was opened, so the process can end with the reason.
    telemetry.stop()
    automation.stop()
    await sessions.close().catch(() => {})
    killAllChildren()
    store.close()
    recordChildrenIn(undefined)
    lock.release()
    throw listenError(err, config.host, config.port)
  }
  port = server.port
  if (relayUrl) startRelay(relayUrl)
  schedules.start()
  log.info(`listening on ${config.host}:${server.port} (data: ${home})`)
  if (!isLoopbackHost(config.host)) {
    log.info(
      `reachable from other machines: ${config.guard.allowLan ? 'tailnet and local network' : 'tailnet only'}, ` +
        `paired devices only. Run "pair" on this machine to add one.`,
    )
  }

  const shutdown = createShutdown({
    log,
    exit: (code) => process.exit(code),
    close: async () => {
      relay?.stop()
      mcpGateway.stop()
      telemetry.stop()
      automation.stop()
      await sessions.close()
      workspace.terminals.shutdown()
      // Agents were asked to stop (stdin closed): give them a moment to save their conversation,
      // then end whatever is left so no agent outlives the host.
      await waitForChildren(2_500)
      killAllChildren()
      await watchers.closeAll()
      await server.close()
      store.close()
      lock.release()
    },
    timeoutMs: 8_000,
  })
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // A closed terminal window (SIGHUP), and Ctrl+Break or a closed console on Windows (SIGBREAK).
  process.on('SIGHUP', () => shutdown('SIGHUP'))
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'))
  // Whatever way the process ends, agents it started do not keep running without it.
  process.on('exit', () => killAllChildren())
  watchForCrashes(log, shutdown)
}

/** Resolves when every agent process has exited, or after `ms`. */
async function waitForChildren(ms: number) {
  const deadline = Date.now() + ms
  while (runningChildren() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
