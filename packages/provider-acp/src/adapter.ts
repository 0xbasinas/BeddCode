import type { ProviderCapabilities, ProviderInstance } from '@beddcode/contracts'
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

/**
 * ACP agents report their modes per session, so none are listed here; the session emits them
 * (`session.modes`) once the agent has answered.
 */
export const acpCapabilities: ProviderCapabilities = {
  resume: true,
  fork: false,
  steer: false,
  planMode: false,
  imageInput: false,
  usage: false,
  permissionModes: [],
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

  return {
    kind: 'acp',
    detect: async () => options.store.list().map(toInstance),
    capabilities: () => acpCapabilities,
    async startSession(instanceId, input) {
      const config = configFor(instanceId)
      if (!config) throw new Error(`Unknown ACP agent: ${instanceId}`)
      const transport =
        options.createTransport?.(config, input.cwd) ??
        spawnTransport(
          resolveExecutable(config.command) ?? config.command,
          config.args,
          { cwd: input.cwd, env: { ...process.env, ...config.env } },
          log,
        )
      return new AcpSession(input, { transport, log, label: config.label })
    },
  }
}
