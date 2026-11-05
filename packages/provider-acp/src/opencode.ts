import type { ProviderAdapter, ProviderSession, StartSessionInput } from '@beddcode/provider-core'
import type { ProviderCapabilities, ProviderInstance, SessionEvent } from '@beddcode/contracts'
import type { SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk'
import {
  createLogger,
  resolveExecutable,
  spawnTransport,
  type Logger,
  type SupervisorClient,
  type Transport,
} from '@beddcode/shared'
import { randomUUID } from 'node:crypto'
import { generateSessionText } from '@beddcode/provider-core'
import { acpTransport } from './supervised.ts'
import { AcpSession } from './session.ts'

export const OPENCODE_INSTANCE_ID = 'opencode'
export const opencodeCapabilities: ProviderCapabilities = {
  textGeneration: true,
  resume: true,
  fork: true,
  steer: false,
  planMode: false,
  imageInput: true,
  usage: true,
  questions: true,
  commands: true,
  history: true,
  mcp: false,
  permissionModes: [],
}

export interface OpenCodeAdapterOptions {
  executablePath?: string
  log?: Logger
  createTransport?: (
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => Transport
  /** Keeps OpenCode running across host restarts (see docs/agent-supervisor.md). */
  supervisor?: SupervisorClient
}

/** OpenCode speaks ACP directly, so the shared ACP session handles permissions, config and resume. */
export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): ProviderAdapter {
  const log = options.log ?? createLogger('opencode')
  const executable = () =>
    options.executablePath
      ? resolveExecutable(options.executablePath)
      : resolveExecutable('opencode')

  const adapter: ProviderAdapter = {
    kind: 'opencode',
    async detect(): Promise<ProviderInstance[]> {
      return [
        {
          id: OPENCODE_INSTANCE_ID,
          kind: 'opencode',
          label: 'OpenCode',
          status: executable() ? 'ready' : 'not-installed',
          capabilities: opencodeCapabilities,
        },
      ]
    },
    capabilities: () => opencodeCapabilities,
    async preview(_id, cwd) {
      const { withAcpAgent } = await import('./history.ts')
      const { approvalSetup } = await import('./permissions.ts')
      const { AcpEventMapper, toConfigOptions } = await import('./mapper.ts')
      const exe = executable()
      if (!exe) throw new Error('OpenCode is not installed on this host.')
      const folder = cwd ?? process.cwd()
      const env = { ...process.env, NO_BROWSER: 'true' }
      const transport =
        options.createTransport?.(exe, ['acp'], folder, env) ??
        spawnTransport(exe, ['acp'], { cwd: folder, env }, log)
      return withAcpAgent(transport, log, 'OpenCode', async (rpc) => {
        const mapper = new AcpEventMapper('preview')
        const events: SessionEvent[] = []
        let announcedConfig: SessionConfigOption[] | undefined
        rpc.onNotification((method, params) => {
          const payload = (params ?? {}) as {
            update?: SessionUpdate
            sessionUpdate?: SessionUpdate['sessionUpdate']
            configOptions?: SessionConfigOption[]
          }
          const update =
            payload.update ?? (payload.sessionUpdate ? (payload as SessionUpdate) : undefined)
          if (method === 'session/update' && update) {
            events.push(...mapper.map(update))
            if (update.sessionUpdate === 'config_option_update')
              announcedConfig = update.configOptions
          }
        })
        const response = await rpc.request<{
          sessionId: string
          modes?: {
            currentModeId?: string
            availableModes?: { id: string; name: string; description?: string | null }[]
          }
          configOptions?: SessionConfigOption[]
        }>('session/new', { cwd: folder, mcpServers: [] }, { timeoutMs: 60_000 })
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rpc
          .request('session/close', { sessionId: response.sessionId }, { timeoutMs: 5_000 })
          .catch(() => {})
        const setup = approvalSetup(
          response.modes,
          toConfigOptions(announcedConfig ?? response.configOptions),
        )
        const commands = events.findLast((event) => event.type === 'session.commands')
        return {
          modes: setup.modes,
          currentModeId: setup.current,
          config: setup.rest,
          commands: commands?.type === 'session.commands' ? commands.commands : [],
        }
      })
    },
    async startSession(_id: string, input: StartSessionInput): Promise<ProviderSession> {
      const exe = executable()
      if (!exe) {
        throw new Error(
          'OpenCode is not installed on this host. Install it from https://opencode.ai and restart BeddCode.',
        )
      }
      const transport =
        options.createTransport?.(exe, ['acp'], input.cwd, { ...process.env }) ??
        (await acpTransport({
          supervisor: options.supervisor,
          input,
          command: exe,
          args: ['acp'],
          env: { ...process.env },
          log,
          name: 'OpenCode',
          plain: () =>
            spawnTransport(exe, ['acp'], { cwd: input.cwd, env: { ...process.env } }, log),
        }))
      // ACP config options are applied in order, so select the model before its variant.
      // Explicit config values take precedence over the legacy model/effort fields.
      const config = {
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...input.config,
      }
      return new AcpSession(
        { ...input, model: undefined, config },
        { transport, log, label: 'OpenCode' },
      )
    },
    async listHistory(_id, cwd) {
      const { withAcpAgent, listAcpSessions } = await import('./history.ts')
      const exe = executable()
      if (!exe) throw new Error('OpenCode is not installed on this host.')
      const folder = cwd ?? process.cwd()
      const env = { ...process.env, NO_BROWSER: 'true' }
      const transport =
        options.createTransport?.(exe, ['acp'], folder, env) ??
        spawnTransport(exe, ['acp'], { cwd: folder, env }, log)
      return withAcpAgent(transport, log, 'OpenCode', (rpc, caps) => {
        if (!caps.sessionCapabilities?.list)
          throw new Error('OpenCode does not support listing sessions on this version.')
        return listAcpSessions(rpc, caps, 'OpenCode', cwd)
      })
    },
    async readHistory(_id, providerSessionId, cwd) {
      const { withAcpAgent, readAcpSession } = await import('./history.ts')
      const exe = executable()
      if (!exe) throw new Error('OpenCode is not installed on this host.')
      const folder = cwd ?? process.cwd()
      const env = { ...process.env, NO_BROWSER: 'true' }
      const transport =
        options.createTransport?.(exe, ['acp'], folder, env) ??
        spawnTransport(exe, ['acp'], { cwd: folder, env }, log)
      return withAcpAgent(transport, log, 'OpenCode', (rpc, caps) => {
        if (!caps.loadSession)
          throw new Error('OpenCode does not support loading session history on this version.')
        return readAcpSession(rpc, caps, 'OpenCode', providerSessionId, folder)
      })
    },
    async forkHistory(_id, from) {
      const exe = executable()
      if (!exe) throw new Error('OpenCode is not installed on this host.')
      const folder = from.cwd
      const env = { ...process.env, NO_BROWSER: 'true' }
      const transport =
        options.createTransport?.(exe, ['acp'], folder, env) ??
        spawnTransport(exe, ['acp'], { cwd: folder, env }, log)
      const { withAcpAgent } = await import('./history.ts')
      return withAcpAgent(transport, log, 'OpenCode', async (rpc, caps) => {
        if (!(caps.sessionCapabilities as { fork?: unknown } | undefined)?.fork)
          throw new Error('OpenCode does not support forking sessions on this version.')
        if (from.throughTurn !== undefined)
          throw new Error(
            'OpenCode ACP can fork sessions, but partial-turn checkpoints are not supported yet.',
          )
        const result = await rpc.request<{ sessionId: string }>(
          'session/fork',
          {
            sessionId: from.providerSessionId,
            cwd: folder,
            mcpServers: [],
          },
          { timeoutMs: 60_000 },
        )
        return result.sessionId
      })
    },
    async generateText(input) {
      const session = await adapter.startSession(input.instanceId, {
        sessionId: randomUUID(),
        cwd: input.cwd,
        model: input.model,
        effort: input.effort,
        permissionMode: 'ask',
        textOnly: true,
      })
      return generateSessionText(session, input.prompt)
    },
    async listCommands(_id, cwd) {
      return (await adapter.preview?.(OPENCODE_INSTANCE_ID, cwd))?.commands ?? []
    },
  }
  return adapter
}
