import type { SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk'
import type { ProviderCapabilities, ProviderInstance, SessionEvent } from '@beddcode/contracts'
import type { ProviderAdapter } from '@beddcode/provider-core'
import {
  createLogger,
  resolveExecutable,
  spawnTransport,
  type Logger,
  type Transport,
} from '@beddcode/shared'
import { instanceIdFor, type AcpAgentConfig, type AcpAgentStore } from './config.ts'
import { AcpSession } from './session.ts'
import { AcpEventMapper, toConfigOptions } from './mapper.ts'
import { approvalSetup } from './permissions.ts'
import { profileFor } from './profiles.ts'
import { listAcpSessions, readAcpSession, withAcpAgent } from './history.ts'

/**
 * ACP agents report their modes per session, so none are listed here; the session emits them
 * (`session.modes`) once the agent has answered.
 */
export const acpCapabilities: ProviderCapabilities = {
  resume: true,
  fork: false,
  steer: false,
  planMode: false,
  // Images go in as image blocks to agents that accept them; others read the file by its path.
  imageInput: true,
  usage: false,
  commands: true,
  // Forms an agent asks for (elicitation, Grok's questions) are shown as questions.
  questions: true,
  history: true,
  permissionModes: [],
}

/**
 * The environment for a process that only looks around (previews, history): it must never open a
 * sign-in page. NO_BROWSER is honoured by Gemini CLI and ignored by the rest. The agent's own
 * settings win over it.
 */
export function probeEnvironment(
  agentEnv: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, NO_BROWSER: 'true', ...agentEnv }
}

export interface AcpAdapterOptions {
  store: AcpAgentStore
  log?: Logger
  /** Injected in tests. */
  createTransport?: (config: AcpAgentConfig, cwd: string) => Transport
}

export function createAcpAdapter(options: AcpAdapterOptions): ProviderAdapter {
  const log = options.log ?? createLogger('acp')

  const toInstance = (config: AcpAgentConfig): ProviderInstance => ({
    id: instanceIdFor(config.id),
    kind: 'acp',
    label: config.label,
    // Sign-in is the agent's own business and only shows up when a session starts.
    status: resolveExecutable(config.command) ? 'ready' : 'not-installed',
    capabilities: acpCapabilities,
  })

  const configFor = (instanceId: string) =>
    options.store.list().find((a) => instanceIdFor(a.id) === instanceId)

  // Looking around (previews, history) must never open a sign-in page: NO_BROWSER is honoured by
  // Gemini CLI and ignored by the rest.
  const transportFor = (config: AcpAgentConfig, cwd: string): Transport =>
    options.createTransport?.(config, cwd) ??
    spawnTransport(
      resolveExecutable(config.command) ?? config.command,
      config.args,
      { cwd, env: probeEnvironment(config.env) },
      log,
    )
  const requireConfig = (instanceId: string) => {
    const config = configFor(instanceId)
    if (!config) throw new Error(`Unknown ACP agent: ${instanceId}`)
    return config
  }

  return {
    kind: 'acp',
    detect: async () => options.store.list().map(toInstance),
    capabilities: () => acpCapabilities,
    /**
     * Starts the agent just long enough to read what a session offers, then stops it. The agent
     * only says so in answer to `session/new`, and its command list follows a moment later.
     */
    async preview(instanceId, cwd) {
      const config = requireConfig(instanceId)
      const folder = cwd ?? process.cwd()
      return withAcpAgent(transportFor(config, folder), log, config.label, async (rpc, caps) => {
        const mapper = new AcpEventMapper('preview')
        const events: SessionEvent[] = []
        rpc.onNotification((method, params) => {
          const update = (params as { update?: SessionUpdate } | undefined)?.update
          if (method === 'session/update' && update) events.push(...mapper.map(update))
        })
        const res = await rpc.request<{
          sessionId: string
          modes?: {
            currentModeId?: string
            availableModes?: { id: string; name: string; description?: string | null }[]
          }
          configOptions?: SessionConfigOption[] | null
        }>('session/new', { cwd: folder, mcpServers: [] }, { timeoutMs: 60_000 })
        // Commands arrive as a notification right after the session exists.
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (caps.sessionCapabilities && 'close' in caps.sessionCapabilities) {
          // Leave no empty session behind in the agent's own history.
          await rpc
            .request('session/close', { sessionId: res.sessionId }, { timeoutMs: 5_000 })
            .catch(() => {})
        }
        const commands = events.findLast((e) => e.type === 'session.commands')
        const setup = approvalSetup(
          res.modes,
          toConfigOptions(res.configOptions),
          profileFor(config.command),
        )
        return {
          modes: setup.modes,
          currentModeId: setup.current,
          config: setup.rest,
          commands: commands?.type === 'session.commands' ? commands.commands : [],
        }
      })
    },
    async listHistory(instanceId, cwd) {
      const config = requireConfig(instanceId)
      return withAcpAgent(
        transportFor(config, cwd ?? process.cwd()),
        log,
        config.label,
        (rpc, caps) => listAcpSessions(rpc, caps, config.label, cwd),
      )
    },
    async readHistory(instanceId, sessionId, cwd) {
      const config = requireConfig(instanceId)
      const folder = cwd ?? process.cwd()
      return withAcpAgent(transportFor(config, folder), log, config.label, (rpc, caps) =>
        readAcpSession(rpc, caps, config.label, sessionId, folder),
      )
    },
    async startSession(instanceId, input) {
      const config = configFor(instanceId)
      if (!config) throw new Error(`Unknown ACP agent: ${instanceId}`)
      // Agents we know start in the chosen mode by their own flags, whatever their config says.
      const profile = profileFor(config.command)
      const launched = profile?.launchArgs
        ? profile.launchArgs(config.args, input.permissionMode)
        : config.args
      const launchedMode =
        profile?.launchArgs && profile.modes.some((m) => m.id === input.permissionMode)
          ? input.permissionMode
          : undefined
      const transport =
        options.createTransport?.({ ...config, args: launched }, input.cwd) ??
        spawnTransport(
          resolveExecutable(config.command) ?? config.command,
          launched,
          { cwd: input.cwd, env: { ...process.env, ...config.env } },
          log,
        )
      return new AcpSession(input, {
        transport,
        log,
        label: config.label,
        profile,
        launchedMode,
      })
    },
  }
}
