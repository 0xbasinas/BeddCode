/**
 * Claude Code waits 10 minutes by default for an API request before giving up and retrying, so one
 * stalled connection can freeze a turn for minutes. Fail faster and let its retry kick in.
 */
export const DEFAULT_API_TIMEOUT_MS = '90000'

/** The environment for the Claude process: the host's, then ours, with the user's own timeout winning. */
export function claudeProcessEnv(
  base: Record<string, string | undefined>,
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env = { API_TIMEOUT_MS: DEFAULT_API_TIMEOUT_MS, ...base, ...extra }
  if (!env.API_TIMEOUT_MS) env.API_TIMEOUT_MS = DEFAULT_API_TIMEOUT_MS
  return env
}
