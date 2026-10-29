import { randomUUID } from 'node:crypto'
import type {
  ModelOption,
  ProviderCapabilities,
  ProviderInstance,
  SlashCommand,
} from '@beddcode/contracts'
import type { ProviderAdapter } from '@beddcode/provider-core'
import { generateSessionText } from '@beddcode/provider-core'
import { AcpSession, grokLaunchArgs, grokProfile } from '@beddcode/provider-acp'
import {
  createLogger,
  resolveExecutable,
  runCommand,
  spawnTransport,
  type Logger,
  type Transport,
} from '@beddcode/shared'
import { grokHooks } from './hooks.ts'
import { readGrokLimits } from './limits.ts'
import { createGrokHistory } from './history.ts'
import { GrokSession, type SpawnFn } from './session.ts'

export const GROK_INSTANCE_ID = 'grok'

/** Reasoning levels `--reasoning-effort` takes; a model may offer more of its own. */
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const profile = grokProfile()

export const grokCapabilities: ProviderCapabilities = {
  textGeneration: true,
  resume: true,
  fork: false,
  steer: false,
  planMode: false,
  imageInput: true,
  usage: false,
  // Grok's questions and plan reviews reach the user through the agent protocol.
  questions: true,
  commands: true,
  history: true,
  permissionModes: profile.modes.map(({ id, label, description, dangerous }) => ({
    id,
    label,
    description,
    dangerous,
  })),
  efforts: EFFORTS,
}

export interface GrokAdapterOptions {
  /** Defaults to the first `grok` on PATH. */
  executablePath?: string
  /** Separate Grok config and sessions (sets GROK_HOME). */
  grokHome?: string
  instanceId?: string
  label?: string
  log?: Logger
  /** Injected in tests. */
  spawnFn?: SpawnFn
  /** Injected in tests: the connection to `grok agent stdio`. */
  createTransport?: (args: string[], cwd: string) => Transport
  run?: typeof runCommand
}

/**
 * The models `grok models` lists:
 *
 *   Default model: grok-4.7-build-fast
 *   Available models:
 *     - grok-4.7
 *     * grok-4.7-build-fast (default)
 */
export function parseModels(stdout: string): ModelOption[] {
  const models: ModelOption[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+([A-Za-z0-9][\w.:/-]*)/.exec(line)
    if (match) models.push({ id: match[1]!, label: match[1]! })
  }
  return models
}

/** Whether `grok models` says the user is signed in; undefined when it does not say. */
export function signedIn(stdout: string, stderr: string): boolean | undefined {
  const text = `${stdout}\n${stderr}`
  if (/not (logged|signed) in|log ?in required|sign ?in required|run .?grok login/i.test(text))
    return false
  if (/logged in/i.test(text)) return true
  return undefined
}

/**
 * The skills Grok finds for a folder, as slash commands. `grok inspect --json` reads its
 * configuration without starting a session. Only the skill names and descriptions are used.
 */
export async function listGrokCommands(
  executable: () => string | null,
  run: typeof runCommand,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<SlashCommand[]> {
  const exe = executable()
  if (!exe) return []
  const res = await run(exe, ['inspect', '--json'], { env, cwd, timeoutMs: 20_000 })
  if (res.code !== 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    return []
  }
  const skills = (parsed as { skills?: unknown }).skills
  if (!Array.isArray(skills)) return []
  return skills.flatMap((s): SlashCommand[] => {
    const skill = s as { name?: unknown; description?: unknown; userInvocable?: unknown }
    if (typeof skill.name !== 'string' || skill.userInvocable === false) return []
    return [
      {
        name: skill.name,
        kind: 'skill',
        ...(typeof skill.description === 'string' && skill.description
          ? { description: skill.description.slice(0, 200) }
          : {}),
      },
    ]
  })
}

export function createGrokAdapter(options: GrokAdapterOptions = {}): ProviderAdapter {
  const instanceId = options.instanceId ?? GROK_INSTANCE_ID
  const log = options.log ?? createLogger('grok')
  const run = options.run ?? runCommand
  const env = options.grokHome ? { GROK_HOME: options.grokHome } : undefined
  let capabilities = grokCapabilities

  const executable = () =>
    options.executablePath ? resolveExecutable(options.executablePath) : resolveExecutable('grok')

  async function detectInstance(): Promise<ProviderInstance> {
    capabilities = grokCapabilities
    const base = {
      id: instanceId,
      kind: 'grok' as const,
      label: options.label ?? 'Grok',
    }
    const exe = executable()
    if (!exe) return { ...base, capabilities, status: 'not-installed' }

    const runEnv = { ...process.env, ...env }
    let version: string | undefined
    try {
      const v = await run(exe, ['--version'], { env: runEnv })
      version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0]
    } catch (err) {
      log.warn('grok detection failed', err)
      return { ...base, capabilities, status: 'error' }
    }

    let status: ProviderInstance['status'] = 'ready'
    try {
      // Only reads local state and the model list; it never starts a session.
      const models = await run(exe, ['models'], { env: runEnv, timeoutMs: 15_000 })
      const found = parseModels(models.stdout)
      if (found.length > 0) capabilities = { ...grokCapabilities, models: found }
      const ok = signedIn(models.stdout, models.stderr)
      if (ok === false && !process.env.XAI_API_KEY && !env) status = 'needs-sign-in'
    } catch (err) {
      log.warn('Grok model discovery failed; the agent picks its own model', err)
    }
    return { ...base, capabilities, status, version }
  }

  const history = createGrokHistory(executable, run, { ...process.env, ...env })

  const agentEnv = { ...process.env, ...env, GROK_OAUTH2_REFERRER: 'beddcode' }
  const hooks = (cwd: string) =>
    grokHooks({
      skills: async () =>
        (await listGrokCommands(executable, run, { ...process.env, ...env }, cwd)).map(
          (c) => c.name,
        ),
    })

  /** A conversation the user has: Grok running as an agent, which can ask before it acts. */
  function startAgent(exe: string, input: ConstructorParameters<typeof AcpSession>[0]) {
    const mode = profile.modes.some((m) => m.id === input.permissionMode)
      ? input.permissionMode
      : undefined
    const args = grokLaunchArgs(['agent', 'stdio'], mode)
    const transport =
      options.createTransport?.(args, input.cwd) ??
      spawnTransport(exe, args, { cwd: input.cwd, env: agentEnv }, log)
    return new AcpSession(input, {
      transport,
      log,
      label: 'Grok',
      profile,
      launchedMode: mode,
      hooks: hooks(input.cwd),
    })
  }

  /** A one-off text job: a locked-down headless run is simpler and leaves no agent behind. */
  const start = (exe: string, input: ConstructorParameters<typeof GrokSession>[0]) =>
    new GrokSession(input, {
      executablePath: exe,
      env,
      log,
      spawnFn: options.spawnFn,
      titleFn: (id) => history.title(id, input.cwd),
    })

  return {
    kind: 'grok',
    detect: async () => [await detectInstance()],
    capabilities: () => capabilities,
    async generateText(input) {
      const exe = executable()
      if (!exe) throw new Error('Grok is not installed on this host')
      return generateSessionText(
        start(exe, {
          sessionId: randomUUID(),
          cwd: input.cwd,
          model: input.model,
          effort: input.effort,
          textOnly: true,
        }),
        input.prompt,
      )
    },
    async listCommands(_instanceId, cwd) {
      return listGrokCommands(executable, run, { ...process.env, ...env }, cwd)
    },
    listHistory: (_instanceId, cwd) => history.list(cwd),
    readHistory: (_instanceId, id) => history.read(id),
    async startSession(_instanceId, input) {
      const exe = executable()
      if (!exe) throw new Error('Grok is not installed on this host')
      return input.textOnly ? start(exe, input) : startAgent(exe, input)
    },
    limits: () => readGrokLimits({ env: { ...process.env, ...env } }),
  }
}
