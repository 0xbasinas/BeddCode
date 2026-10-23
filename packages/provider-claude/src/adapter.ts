import {
  forkSession,
  getSessionMessages,
  listSessions,
  query,
} from '@anthropic-ai/claude-agent-sdk'
import type { ProviderCapabilities, ProviderInstance, ProviderStatus } from '@beddcode/contracts'
import type { ProviderAdapter } from '@beddcode/provider-core'
import { createLogger, resolveExecutable, runCommand, type Logger } from '@beddcode/shared'
import { ClaudeSession, type QueryFn } from './session.ts'
import { discoverClaudeModels } from './models.ts'
import { scanClaudeCommands } from './commands.ts'
import { createClaudeHistory, type ClaudeHistorySdk } from './history.ts'
import { createClaudeMcp } from './mcp.ts'
import { readClaudeLimits } from './limits.ts'

export const CLAUDE_INSTANCE_ID = 'claude'

/** Claude's own permission mode ids, passed through unchanged. */
export const claudeCapabilities: ProviderCapabilities = {
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
  /** Defaults to the first `claude` on PATH. */
  executablePath?: string
  /** Separate Claude account/config (sets CLAUDE_CONFIG_DIR). */
  configDir?: string
  instanceId?: string
  label?: string
  log?: Logger
  /** Injected in tests. */
  queryFn?: QueryFn
  historySdk?: ClaudeHistorySdk
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): ProviderAdapter {
  const instanceId = options.instanceId ?? CLAUDE_INSTANCE_ID
  const log = options.log ?? createLogger('claude')
  const queryFn = options.queryFn ?? (query as QueryFn)
  const env = options.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : undefined
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
    if (!exe) return { ...base, status: 'not-installed' }

    const runEnv = { ...process.env, ...env }
    let version: string | undefined
    let status: ProviderStatus = 'ready'
    try {
      const v = await runCommand(exe, ['--version'], { env: runEnv })
      version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0]
      // `auth status` only reads local credentials; it does not start a session.
      const auth = await runCommand(exe, ['auth', 'status'], { env: runEnv })
      if (auth.code !== 0) status = 'needs-sign-in'
      else {
        const parsed = safeJson(auth.stdout) as { loggedIn?: boolean } | null
        if (parsed && parsed.loggedIn === false) status = 'needs-sign-in'
      }
    } catch (err) {
      log.warn('claude detection failed', err)
      status = 'error'
    }
    if (status === 'ready') {
      try {
        capabilities = {
          ...claudeCapabilities,
          models: await discoverClaudeModels(queryFn, exe, env),
        }
      } catch (err) {
        log.warn('Claude model discovery failed; using unversioned CLI aliases', err)
      }
    }
    return { ...base, capabilities, status, version }
  }

  return {
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
      return new ClaudeSession(input, {
        queryFn,
        log,
        executablePath: exe,
        env,
        modes: claudeCapabilities.permissionModes,
      })
    },
    listHistory: (_instanceId, cwd) => history.list(cwd),
    readHistory: (_instanceId, id, cwd) => history.read(id, cwd),
    forkHistory: (_instanceId, from) =>
      history.fork(from.providerSessionId, from.cwd, from.throughTurn),
    listCommands: async (_instanceId, cwd) => scanClaudeCommands(cwd),
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
