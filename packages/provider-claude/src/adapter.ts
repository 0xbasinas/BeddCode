import {
  forkSession,
  getSessionMessages,
  listSessions,
  query,
} from '@anthropic-ai/claude-agent-sdk'
import type { ProviderCapabilities, ProviderInstance, ProviderStatus } from '@beddcode/contracts'
import type { ProviderAdapter } from '@beddcode/provider-core'
import { ClaudeCliSession } from './cli/session.ts'
import {
  createLogger,
  resolveExecutable,
  runCommand,
  type Logger,
  type SupervisorClient,
} from '@beddcode/shared'
import { ClaudeSession, type QueryFn } from './session.ts'
import { discoverClaudeModels } from './models.ts'
import { CLAUDE_BUILTINS, scanClaudeCommands } from './commands.ts'
import { createClaudeHistory, type ClaudeHistorySdk } from './history.ts'
import { createClaudeMcp } from './mcp.ts'
import { readClaudeLimits } from './limits.ts'
import { generateSessionText } from '@beddcode/provider-core'
import { randomUUID } from 'node:crypto'

export const CLAUDE_INSTANCE_ID = 'claude'

/** Claude's own permission mode ids, passed through unchanged. */
export const claudeCapabilities: ProviderCapabilities = {
  textGeneration: true,
  resume: true,
  fork: true,
  steer: true,
  planMode: true,
  imageInput: false,
  usage: false,
  questions: true,
  commands: true,
  history: true,
  mcp: true,
  permissionModes: [
    {
      id: 'default',
      label: 'Ask before edits',
      description: 'Asks before changing files or running commands',
    },
    {
      id: 'acceptEdits',
      label: 'Auto-accept edits',
      description: 'File edits go through, commands still ask',
    },
    { id: 'plan', label: 'Plan mode', description: 'Proposes a plan and waits for your approval' },
    {
      id: 'bypassPermissions',
      label: 'Full access',
      description: 'No prompts at all. Use only in a sandbox.',
      dangerous: true,
    },
  ],
  // Claude Code's own model aliases; each resolves to the latest model of that family.
  models: [
    { id: 'sonnet', label: 'Sonnet', description: 'Balanced speed and quality' },
    { id: 'opus', label: 'Opus', description: 'Deep reasoning for complex changes' },
    { id: 'haiku', label: 'Haiku', description: 'Fast and light, for small edits' },
  ],
  // Effort support comes from the CLI's per-model metadata.
  efforts: [],
}

export interface ClaudeAdapterOptions {
  backend?: 'sdk' | 'cli'
  /** Defaults to the first `claude` on PATH. */
  executablePath?: string
  /** Separate Claude account/config (sets CLAUDE_CONFIG_DIR). */
  configDir?: string
  mcpEnv?: Record<string, string>
  instanceId?: string
  label?: string
  log?: Logger
  /** Injected in tests. */
  queryFn?: QueryFn
  historySdk?: ClaudeHistorySdk
  /** Keeps agents running across host restarts (off unless given; see docs/agent-supervisor.md). */
  supervisor?: SupervisorClient
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): ProviderAdapter {
  const instanceId = options.instanceId ?? CLAUDE_INSTANCE_ID
  const log = options.log ?? createLogger('claude')
  const queryFn = options.queryFn ?? (query as QueryFn)
  const env = options.mcpEnv ?? {}
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir
  let capabilities = claudeCapabilities
  const history = createClaudeHistory(
    options.historySdk ?? ({ listSessions, getSessionMessages, forkSession } as ClaudeHistorySdk),
  )

  // An explicit path must exist; otherwise fall back to PATH lookup only when none was given.
  const executable = () =>
    options.executablePath ? resolveExecutable(options.executablePath) : resolveExecutable('claude')

  async function detectInstance(): Promise<ProviderInstance> {
    capabilities = claudeCapabilities
    const base = {
      id: instanceId,
      kind: 'claude' as const,
      label: options.label ?? 'Claude Code',
      capabilities: claudeCapabilities,
    }
    const exe = executable()
    if (!exe)
      return {
        ...base,
        status: 'not-installed',
        ...(options.backend === 'cli' ? { reason: 'Claude CLI not found' } : {}),
      }

    const runEnv = { ...process.env, ...env }
    let version: string | undefined
    let status: ProviderStatus = 'ready'
    try {
      const v = await runCommand(exe, ['--version'], { env: runEnv })
      if (v.code !== 0) throw new Error('Claude version check failed')
      version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0]
      if (v.code !== 0 && options.backend === 'cli')
        return { ...base, status: 'not-installed', reason: 'Claude CLI not found' }
      // `auth status` only reads local credentials; it does not start a session.
      let auth = await runCommand(
        exe,
        options.backend === 'cli' ? ['auth', 'status', '--json'] : ['auth', 'status'],
        { env: runEnv },
      )
      if (options.backend === 'cli' && auth.code !== 0 && !safeJson(auth.stdout))
        auth = await runCommand(exe, ['auth', 'status'], { env: runEnv })
      if (!isClaudeSignedIn(auth.stdout, auth.code)) status = 'needs-sign-in'
    } catch (err) {
      log.warn('claude detection failed', err)
      status = options.backend === 'cli' ? 'not-installed' : 'error'
    }
    if (status === 'ready' && options.backend !== 'cli') {
      try {
        capabilities = {
          ...claudeCapabilities,
          models: await discoverClaudeModels(queryFn, exe, env),
        }
      } catch (err) {
        log.warn('Claude model discovery failed; using unversioned CLI aliases', err)
      }
    }
    const reason =
      options.backend === 'cli'
        ? status === 'not-installed'
          ? 'Claude CLI not found'
          : status === 'needs-sign-in'
            ? 'Claude CLI not signed in'
            : undefined
        : undefined
    return { ...base, capabilities, status, version, reason }
  }

  return {
    // The SDK query starts with session-specific resume, permissions, and MCP options.
    warmPool: { supported: false },
    generateText: (input) =>
      generateSessionText(
        new (options.backend === 'cli' ? ClaudeCliSession : ClaudeSession)(
          {
            sessionId: randomUUID(),
            cwd: input.cwd,
            model: input.model,
            effort: input.effort,
            textOnly: true,
          },
          { queryFn, log, executablePath: executable() ?? undefined, env },
        ),
        input.prompt,
      ),
    kind: 'claude',
    detect: async () => [await detectInstance()],
    capabilities: () => capabilities,
    async limits() {
      const exe = executable()
      if (!exe) throw new Error('Claude Code is not installed on this host')
      return readClaudeLimits(queryFn, { executablePath: exe, env })
    },
    async startSession(_instanceId, input) {
      const exe = executable()
      if (!exe) throw new Error('Claude Code is not installed on this host')
      if ((input.claudeBackend ?? options.backend ?? 'sdk') === 'cli')
        return new ClaudeCliSession(input, {
          log,
          executablePath: exe,
          env,
          modes: claudeCapabilities.permissionModes,
        })
      const attached = input.reattach
        ? await options.supervisor?.attach(input.sessionId).catch((err: unknown) => {
            log.warn(`could not reattach ${input.sessionId}; starting a new agent`, err)
            return undefined
          })
        : undefined
      if (attached)
        log.info(`reattached ${input.sessionId} to its running agent (pid ${attached.pid})`)
      return new ClaudeSession(input, {
        queryFn,
        log,
        executablePath: exe,
        env,
        modes: claudeCapabilities.permissionModes,
        supervisor: options.supervisor,
        attached,
      })
    },
    listHistory: (_instanceId, cwd) => history.list(cwd),
    readHistory: (_instanceId, id, cwd) => history.read(id, cwd),
    forkHistory: (_instanceId, from) =>
      history.fork(from.providerSessionId, from.cwd, from.throughTurn),
    listCommands: async (_instanceId, cwd) => {
      const custom = scanClaudeCommands(cwd)
      const names = new Set(custom.map((c) => c.name))
      return [...custom, ...CLAUDE_BUILTINS.filter((c) => !names.has(c.name))]
    },
    mcp: createClaudeMcp(executable, env),
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function isClaudeSignedIn(output: string, code: number | null): boolean {
  const parsed = safeJson(output) as { loggedIn?: boolean } | null
  if (typeof parsed?.loggedIn === 'boolean') return parsed.loggedIn
  if (/not (?:logged|signed) in|unauthenticated|logged out/i.test(output)) return false
  return code === 0
}
