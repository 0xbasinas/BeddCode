import type { ProviderCapabilities, ProviderInstance, ProviderStatus } from '@beddcode/contracts'
import type { ProviderAdapter } from '@beddcode/provider-core'
import {
  createLogger,
  resolveExecutable,
  runCommand,
  spawnTransport,
  type Logger,
  type Transport,
} from '@beddcode/shared'
import { codexModes } from './modes.ts'
import { CodexSession } from './session.ts'
import { discoverCodexModels } from './models.ts'
import { createCodexHistory, createWithAppServer, listCodexSkills } from './history.ts'
import { createCodexMcp } from './mcp.ts'

export const CODEX_INSTANCE_ID = 'codex'

export const codexCapabilities: ProviderCapabilities = {
  resume: true,
  fork: true,
  steer: true,
  planMode: false,
  imageInput: false,
  usage: false,
  questions: true,
  commands: true,
  history: true,
  mcp: true,
  permissionModes: codexModes.map(({ id, label, description, dangerous }) => ({
    id,
    label,
    description,
    dangerous,
  })),
}

export interface CodexAdapterOptions {
  /** Defaults to the first `codex` on PATH. */
  executablePath?: string
  /** Separate Codex home/account (sets CODEX_HOME). */
  codexHome?: string
  instanceId?: string
  label?: string
  log?: Logger
  /** Injected in tests. */
  createTransport?: (cwd: string) => Transport
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): ProviderAdapter {
  const instanceId = options.instanceId ?? CODEX_INSTANCE_ID
  const log = options.log ?? createLogger('codex')
  const env = { ...process.env, ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}) }
  let capabilities = codexCapabilities

  const executable = () =>
    options.executablePath ? resolveExecutable(options.executablePath) : resolveExecutable('codex')

  // History, forks and skill lists talk to a throwaway app-server rather than a live session.
  const appServer = createWithAppServer((cwd) => {
    const exe = executable()
    if (!exe) throw new Error('Codex is not installed on this host')
    return options.createTransport?.(cwd) ?? spawnTransport(exe, ['app-server'], { env, cwd }, log)
  }, log)
  const history = createCodexHistory(appServer)

  async function detectInstance(): Promise<ProviderInstance> {
    const base = {
      id: instanceId,
      kind: 'codex' as const,
      label: options.label ?? 'Codex',
      capabilities: codexCapabilities,
    }
    const exe = executable()
    if (!exe) return { ...base, status: 'not-installed' }

    let version: string | undefined
    let status: ProviderStatus = 'ready'
    try {
      const v = await runCommand(exe, ['--version'], { env })
      version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0]
      // `login status` reads local credentials only; it does not start the app server.
      const auth = await runCommand(exe, ['login', 'status'], { env })
      if (auth.code !== 0) status = 'needs-sign-in'
    } catch (err) {
      log.warn('codex detection failed', err)
      status = 'error'
    }
    if (status === 'ready') {
      try {
        const transport =
          options.createTransport?.(process.cwd()) ??
          spawnTransport(exe, ['app-server'], { env, cwd: process.cwd() }, log)
        capabilities = { ...codexCapabilities, ...(await discoverCodexModels(transport, log)) }
      } catch (err) {
        log.warn('Codex model discovery failed; using the CLI configuration', err)
        capabilities = codexCapabilities
      }
    }
    return { ...base, capabilities, status, version }
  }

  return {
    kind: 'codex',
    detect: async () => [await detectInstance()],
    capabilities: () => capabilities,
    async startSession(_instanceId, input) {
      const exe = executable()
      if (!exe) throw new Error('Codex is not installed on this host')
      const transport =
        options.createTransport?.(input.cwd) ??
        spawnTransport(exe, ['app-server'], { env, cwd: input.cwd }, log)
      return new CodexSession(input, { transport, log })
    },
    listHistory: (_instanceId, cwd) => history.list(cwd),
    readHistory: (_instanceId, id, cwd) => history.read(id, cwd),
    forkHistory: (_instanceId, from) =>
      history.fork(from.providerSessionId, from.cwd, from.throughTurn),
    listCommands: (_instanceId, cwd) => listCodexSkills(appServer, cwd ?? process.cwd()),
    mcp: createCodexMcp(executable, env),
  }
}
