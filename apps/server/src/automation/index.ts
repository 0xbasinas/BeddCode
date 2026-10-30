import path from 'node:path'
import type { RpcParams } from '@beddcode/contracts'
import { createLogger } from '@beddcode/shared'
import type { SessionManager, SessionOrigin } from '../sessions/sessionManager.ts'
import type { EventStore } from '../store/eventStore.ts'
import { runWorktreeSetup, type WorkspaceServices } from '../transport/rpc.ts'
import { AgentTools, modeLevel } from './agentTools.ts'
import { AlertService } from './alerts.ts'
import { writeBridge } from './bridge.ts'
import { DesignStore } from '../design/designStore.ts'
import { DesignTools } from '../design/designTools.ts'
import { DesignLink } from '../design/designLink.ts'
import { BrowserBroker, BrowserTools, type BrowserToolsHost } from './browserUse.ts'
import { auditFile } from '../computer/audit.ts'
import { ComputerTools, type ComputerToolsHost } from '../computer/computerTools.ts'
import { CuaDesktopDriver } from '../computer/cuaDriver.ts'
import { LinearKeyStore, LinearTools } from '../linear/linearTools.ts'
import { ScheduleService } from './schedules.ts'

/** The Desktop pane's view of a session's computer use. */
export interface ComputerPane {
  view(sessionId: string, since?: number): ReturnType<ComputerTools['viewOf']>
  control(sessionId: string, paused: boolean): boolean
}

export interface AutomationDeps {
  home: string
  hostId: string
  sessions: SessionManager
  store: EventStore
  workspace: Pick<WorkspaceServices, 'projects' | 'terminals' | 'git'>
  /** The port the host listens on, for the agent tools' bridge to call back. */
  port: () => number
  /** Where pictures of the browser pages agents use are kept. */
  browserImageDir?: string
  /** Where pictures of the windows agents operate are kept. */
  computerImageDir?: string
  fetch?: ConstructorParameters<typeof AlertService>[0]['fetch']
  tickMs?: number
}

/** Schedules, phone alerts and the agent tools, wired to the sessions and the log. */
export function createAutomation(deps: AutomationDeps) {
  const { sessions, store, workspace, home } = deps
  // Sessions started by schedules and by agents set up their worktrees like the user's do.
  const create = async (params: RpcParams<'sessions.create'>, origin: SessionOrigin) => {
    const created = await sessions.create(params, origin)
    runWorktreeSetup(sessions, workspace, params, created.sessionId)
    return created
  }
  const prompt = (sessionId: string, text: string) => sessions.prompt(sessionId, text)
  const readSession = (sessionId: string) => store.readSession(sessionId)
  const subscribe = (listener: Parameters<EventStore['subscribe']>[0]) => store.subscribe(listener)
  const isBusy = (id: string) => sessions.isBusy(id)

  let schedules: ScheduleService | undefined
  const alerts = new AlertService({
    file: path.join(home, 'alerts.json'),
    log: createLogger('alerts'),
    hostId: deps.hostId,
    readSession,
    scheduledTurn: (sessionId) => schedules?.coversTurn(sessionId) ?? false,
    fetch: deps.fetch,
  })
  schedules = new ScheduleService({
    file: path.join(home, 'schedules.json'),
    host: { create, prompt, isBusy, readSession, subscribe },
    log: createLogger('schedules'),
    onRunEnded: (run, schedule) => alerts.onRunEnded(run, schedule),
    tickMs: deps.tickMs,
  })
  const broker = new BrowserBroker()
  const toolHost: BrowserToolsHost & ComputerToolsHost = {
    currentMode: (id) => sessions.currentMode(id),
    modeLevel,
    askUser: (id, ask) => sessions.askUser(id, ask),
    async describe(id) {
      const created = store.readSession(id).find((e) => e.event.type === 'session.created')
      const event = created?.event.type === 'session.created' ? created.event : undefined
      const providers = await sessions.listProviders().catch(() => [])
      const label = providers.find((p) => p.id === event?.instanceId)?.label
      const agent = (label ?? event?.instanceId ?? 'Agent').replace(/\s*\(.*\)$/, '')
      let title = event?.title
      for (const { event: e } of store.readSession(id))
        if (e.type === 'session.renamed') title = e.title
      return { agent, title }
    },
  }
  const browser = new BrowserTools(
    broker,
    toolHost,
    deps.browserImageDir ?? path.join(home, 'browser-images'),
  )
  const computer = new ComputerTools(
    () => CuaDesktopDriver.load(),
    toolHost,
    deps.computerImageDir ?? path.join(home, 'computer-images'),
    { audit: auditFile(path.join(home, 'computer-audit.jsonl')) },
  )
  const designs = new DesignStore(path.join(home, 'designs'))
  const designLink = new DesignLink()
  const linearKey = new LinearKeyStore(path.join(home, 'linear.json'))
  const agentTools = new AgentTools(
    {
      create,
      prompt,
      interrupt: (id) => sessions.interrupt(id),
      isBusy,
      currentMode: (id) => sessions.currentMode(id),
      providers: () => sessions.listProviders(),
      readSession,
      childrenOf: (id) => store.childrenOf(id),
      subscribe,
      projectPaths: async () => (await workspace.projects.list()).map((p) => p.path),
      diff: async (cwd) => {
        const changed = (await workspace.git.status(cwd)).files.slice(0, 200).map((f) => f.path)
        if (changed.length > 0)
          return (await workspace.git.generationContext(cwd, 'commit', changed)).text
        return (await workspace.git.generationContext(cwd, 'pr').catch(() => ({ text: '' }))).text
      },
      report: (sessionId, status, summary) =>
        void store.append({ type: 'session.result', sessionId, at: Date.now(), status, summary }),
    },
    { file: writeBridge(home), url: () => `http://127.0.0.1:${deps.port()}/agent-tools` },
    browser,
    new DesignTools(designs, designLink),
    computer,
    new LinearTools(linearKey),
  )
  const stopAlerts = store.subscribe((stored) => {
    alerts.onEvent(stored)
    if (stored.event.type === 'session.deleted') agentTools.forget(stored.event.sessionId)
    // A turn that ends frees the desktop for other sessions; a stopped one also loses its access.
    if (stored.event.type === 'turn.started') computer.resume(stored.event.sessionId)
    if (stored.event.type === 'turn.completed') {
      computer.release(stored.event.sessionId)
      if (stored.event.reason === 'cancelled') computer.halt(stored.event.sessionId)
    }
  })
  // What the Desktop pane reads and does for a session that may use the computer.
  const computerPane: ComputerPane = {
    view: (sessionId, since) => {
      const created = store.readSession(sessionId).find((e) => e.event.type === 'session.created')
      const enabled =
        created?.event.type === 'session.created' && created.event.computerTools === true
      return computer.viewOf(sessionId, enabled, since)
    },
    control: (sessionId, paused) => computer.setPaused(sessionId, paused),
  }
  return {
    computerPane,
    schedules,
    alerts,
    agentTools,
    browser: broker,
    designs,
    designLink,
    linear: {
      setKey(key: string | null) {
        linearKey.set(key)
        return linearKey.get() !== undefined
      },
    },
    stop() {
      schedules.stop()
      stopAlerts()
      void computer.dispose()
    },
  }
}
