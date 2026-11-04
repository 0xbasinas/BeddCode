import type { ProviderCapabilities, ProviderInstance, ProviderStatus } from '@beddcode/contracts'
import type { ProviderAdapter } from '@beddcode/provider-core'
import {
  createLogger,
  measureProcessMemory,
  resolveExecutable,
  runCommand,
  spawnTransport,
  type Logger,
  type Transport,
} from '@beddcode/shared'
import { codexModes } from './modes.ts'
import { CodexSession, prepareCodexProcess } from './session.ts'
import { discoverCodexModels } from './models.ts'
import { createCodexHistory, createWithAppServer, listCodexSkills } from './history.ts'
import { createCodexMcp } from './mcp.ts'
import { CODEX_BUILTINS, scanCodexPrompts } from './commands.ts'
import { readCodexLimits } from './limits.ts'
import { generateSessionText } from '@beddcode/provider-core'
import { randomUUID } from 'node:crypto'
import { createCodexFingerprint } from './fingerprint.ts'

export const CODEX_INSTANCE_ID = 'codex'

export const codexCapabilities: ProviderCapabilities = {
  textGeneration: true,
  resume: true,
  fork: true,
  steer: true,
  planMode: false,
  imageInput: true,
  usage: true,
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
  mcpEnv?: Record<string, string>
  instanceId?: string
  label?: string
  log?: Logger
  /** Injected in tests. */
  createTransport?: (cwd: string) => Transport
}

export interface CodexWarmSession {
  healthy(): Promise<boolean>
  memoryBytes(): Promise<number | null>
  activate(
    input: import('@beddcode/provider-core').StartSessionInput,
  ): Promise<import('@beddcode/provider-core').ProviderSession>
  close(): Promise<void>
}

export interface CodexAdapter extends ProviderAdapter {
  prepareSession(cwd: string): Promise<CodexWarmSession>
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): CodexAdapter {
  const instanceId = options.instanceId ?? CODEX_INSTANCE_ID
  const log = options.log ?? createLogger('codex')
  const env = () => ({
    ...process.env,
    ...options.mcpEnv,
    ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}),
  })
  let capabilities = codexCapabilities

  const executable = () =>
    options.executablePath
      ? resolveExecutable(options.executablePath, env())
      : resolveExecutable('codex', env())

  // History, forks and skill lists talk to a throwaway app-server rather than a live session.
  const appServer = createWithAppServer((cwd) => {
    const exe = executable()
    if (!exe) throw new Error('Codex is not installed on this host')
    return (
      options.createTransport?.(cwd) ??
      spawnTransport(exe, ['app-server'], { env: env(), cwd }, log)
    )
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
      const v = await runCommand(exe, ['--version'], { env: env() })
      version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0]
      // `login status` reads local credentials only; it does not start the app server.
      const auth = await runCommand(exe, ['login', 'status'], { env: env() })
      if (auth.code !== 0) status = 'needs-sign-in'
    } catch (err) {
      log.warn('codex detection failed', err)
      status = 'error'
    }
    if (status === 'ready') {
      try {
        const transport =
          options.createTransport?.(process.cwd()) ??
          spawnTransport(exe, ['app-server'], { env: env(), cwd: process.cwd() }, log)
        capabilities = { ...codexCapabilities, ...(await discoverCodexModels(transport, log)) }
      } catch (err) {
        log.warn('Codex model discovery failed; using the CLI configuration', err)
        capabilities = codexCapabilities
      }
    }
    return { ...base, capabilities, status, version }
  }

  const fingerprint = createCodexFingerprint(executable, env)

  async function prepareSession(cwd: string): Promise<CodexWarmSession> {
    const exe = executable()
    if (!exe) throw new Error('Codex is not installed on this host')
    const transport =
      options.createTransport?.(cwd) ??
      spawnTransport(exe, ['app-server'], { env: env(), cwd }, log)
    const prepared = await prepareCodexProcess({ transport, log })
    return {
      healthy: async () => prepared.healthy(),
      // A process that cannot be measured counts as an estimate, so the cap still applies.
      memoryBytes: () => measureProcessMemory(transport.pid),
      activate: async (input) => {
        if (input.cwd !== cwd)
          throw new Error('Prepared Codex process has a different working directory')
        return prepared.start(input)
      },
      close: async () => prepared.close(),
    }
  }

  return {
    prepareSession,
    warmPool: { supported: true, prepareSession, fingerprint },
    generateText: async (input) => {
      const exe = executable()
      if (!exe) throw new Error('Codex is not installed on this host')
      const transport =
        options.createTransport?.(input.cwd) ??
        spawnTransport(exe, ['app-server'], { env: env(), cwd: input.cwd }, log)
      return generateSessionText(
        new CodexSession(
          {
            sessionId: randomUUID(),
            cwd: input.cwd,
            model: input.model,
            effort: input.effort,
            permissionMode: 'read-only',
            textOnly: true,
          },
          { transport, log },
        ),
        input.prompt,
      )
    },
    kind: 'codex',
    detect: async () => [await detectInstance()],
    capabilities: () => capabilities,
    async startSession(_instanceId, input) {
      const exe = executable()
      if (!exe) throw new Error('Codex is not installed on this host')
      const transport =
        options.createTransport?.(input.cwd) ??
        spawnTransport(exe, ['app-server'], { env: env(), cwd: input.cwd }, log)
      return new CodexSession(input, { transport, log })
    },
    listHistory: (_instanceId, cwd) => history.list(cwd),
    readHistory: (_instanceId, id, cwd) => history.read(id, cwd),
    forkHistory: (_instanceId, from) =>
      history.fork(from.providerSessionId, from.cwd, from.throughTurn),
    limits: () => readCodexLimits(appServer),
    listCommands: async (_instanceId, cwd) => [
      ...CODEX_BUILTINS,
      ...scanCodexPrompts(),
      ...(await listCodexSkills(appServer, cwd ?? process.cwd()).catch(() => [])),
    ],
    mcp: createCodexMcp(executable, env),
  }
}
