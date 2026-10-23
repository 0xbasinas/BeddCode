import path from 'node:path'
import type { RpcParams } from '@beddcode/contracts'
import { createLogger } from '@beddcode/shared'
import type { SessionManager, SessionOrigin } from '../sessions/sessionManager.ts'
import type { EventStore } from '../store/eventStore.ts'
import { runWorktreeSetup, type WorkspaceServices } from '../transport/rpc.ts'
import { AgentTools } from './agentTools.ts'
import { AlertService } from './alerts.ts'
import { writeBridge } from './bridge.ts'
import { ScheduleService } from './schedules.ts'

export interface AutomationDeps {
  home: string
  hostId: string
  sessions: SessionManager
  store: EventStore
  workspace: Pick<WorkspaceServices, 'projects' | 'terminals'>
  /** The port the host listens on, for the agent tools' bridge to call back. */
  port: () => number
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
    },
    { file: writeBridge(home), url: () => `http://127.0.0.1:${deps.port()}/agent-tools` },
  )
  const stopAlerts = store.subscribe((stored) => alerts.onEvent(stored))
  return {
    schedules,
    alerts,
    agentTools,
    stop() {
      schedules.stop()
      stopAlerts()
    },
  }
}
