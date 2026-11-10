import { JsonRpcError } from '@beddcode/shared'

/**
 * Launch-time fixes for specific ACP agents, adapted from acpx (https://github.com/openclaw/acpx,
 * MIT, © 2025 OpenClaw Team): which flag an older CLI wants, and what to tell the user when an
 * agent starts but never gets as far as answering `initialize`.
 */

const name = (command: string) =>
  (command.split(/[\\/]/).pop() ?? command).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()

/** `0.32.1` or `gemini 0.32.1` to [0, 32, 1]. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

function older(a: number[], b: number[]): boolean {
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) < b[i]!
  }
  return false
}

/** Gemini CLI took `--acp` from 0.33; before that the flag was `--experimental-acp`. */
const GEMINI_ACP_FLAG = [0, 33, 0]

export const isGeminiAcp = (command: string, args: readonly string[]) =>
  name(command) === 'gemini' && args.includes('--acp')

/** The arguments for this Gemini CLI version: the old flag name for a CLI that predates `--acp`. */
export function geminiArgs(args: string[], versionOutput: string | undefined): string[] {
  const version = versionOutput ? parseVersion(versionOutput) : undefined
  return version && older(version, GEMINI_ACP_FLAG)
    ? args.map((a) => (a === '--acp' ? '--experimental-acp' : a))
    : args
}

/**
 * Extra help for a failure to start, from what is known about the agent: shown after the plain
 * error (a timeout, or the process ending) when it is the likely cause.
 */
export function startupHint(
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): string | undefined {
  const agent = name(command)
  if (agent === 'gemini') {
    return env.GEMINI_API_KEY || env.GOOGLE_API_KEY
      ? 'Gemini CLI may be waiting on interactive sign-in or need an upgrade.'
      : 'Gemini CLI may be waiting on interactive sign-in. Set GEMINI_API_KEY or GOOGLE_API_KEY on this host for non-interactive use, and upgrade Gemini CLI.'
  }
  if (agent === 'copilot' && args.includes('--acp')) {
    return 'This GitHub Copilot CLI may be too old for ACP stdio mode (copilot --acp --stdio). Upgrade it.'
  }
  if (agent === 'qodercli' || agent === 'qoder') {
    return 'Qoder prints status lines on stdout while it shuts down; BeddCode ignores them. Check that `qodercli --acp` runs on its own.'
  }
  if (agent === 'cursor-agent') {
    return 'Run `cursor-agent login` on this host if you have not signed in.'
  }
  return undefined
}

/**
 * Devin refuses ACP clients it does not recognise: it wants to be spoken to as the Windsurf IDE
 * and to be told the client can take diagnostics requests. (From acpx, which verified the version
 * against Devin Desktop 3.1.7.)
 */
export const isDevinAcp = (command: string, args: readonly string[]) =>
  name(command) === 'devin' &&
  (args.includes('acp') || args.includes('--acp') || args.includes('--experimental-acp'))

export const DEVIN_CLIENT = { name: 'windsurf', version: '1.110.1' }
export const DEVIN_CAPABILITIES_META = { 'cognition.ai/requestDiagnostics': true }

/** JSON-RPC internal error and parse error: how agents report a failed model call or a garbled reply. */
const TRANSIENT_CODES = new Set([-32603, -32700])

/**
 * Whether a failed `session/prompt` is worth sending again: the agent reported an internal or
 * parse error, which is usually a model API hiccup. Auth, missing-session and invalid-params
 * errors are not. (acpx's `isRetryablePromptError`, with its policy of retrying only while the
 * turn has had no effect yet.)
 */
export const isTransientPromptError = (err: unknown) =>
  err instanceof JsonRpcError && TRANSIENT_CODES.has(err.code)

/** How many times a transient prompt failure is retried, and the wait before each (1s, 2s, ... up to 10s). */
export const PROMPT_RETRIES = 2
export const promptRetryDelayMs = (attempt: number) => Math.min(1000 * 2 ** attempt, 10_000)

/** True for the plain messages that mean "never answered" or "went away at startup". */
export const isStartupFailure = (message: string) =>
  /timed out|timeout|ended|closed|stopped/i.test(message)
