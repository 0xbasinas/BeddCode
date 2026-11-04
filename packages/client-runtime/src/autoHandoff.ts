import type { ProviderInstance, ProviderKind } from '@beddcode/contracts'

export type HandoffMode = 'off' | 'ask' | 'auto'
export interface HandoffPolicy {
  mode: HandoffMode
  fallback: string[]
  maxHops: number
  cooldownMs: number
}

/** Provider adapters normalize errors to text; these patterns cover their common native wording. */
const providerPatterns: Partial<Record<ProviderKind, RegExp>> = {
  codex: /usage limit|rate limit|insufficient_quota|context length|context window/i,
  claude: /usage limit|rate.limit|overloaded_error|credit balance|prompt is too long/i,
  grok: /rate.limit|quota|context length|credits exhausted/i,
  acp: /rate.limit|quota|context (?:window|length)|not authenticated/i,
  pi: /rate.limit|quota|context (?:window|length)|no api key/i,
  opencode: /rate.limit|quota|context (?:window|length)|not authenticated/i,
  fake: /rate.limit|quota|context (?:window|length)/i,
}

export function detectHandoffTrigger(
  kind: ProviderKind,
  message: string,
  recentErrors = 1,
): string | undefined {
  const text = message.trim()
  if (!text) return undefined
  if (
    /not (?:logged|signed) in|unauthenticated|authentication required|invalid api key|no api key|provider unavailable/i.test(
      text,
    )
  )
    return text
  if (
    /\b429\b|rate.?limit|usage limit|quota (?:exceeded|exhausted)|insufficient.quota|context (?:window|length).*(?:exceed|full|limit)|maximum context|too many tokens/i.test(
      text,
    ) ||
    providerPatterns[kind]?.test(text)
  )
    return text
  if (recentErrors >= 3 && /error|failed|crash|stopped unexpectedly|unavailable/i.test(text))
    return text
  return undefined
}

/** Choose only an explicitly configured, ready instance which has not recently failed. */
export function chooseHandoffAgent(
  policy: HandoffPolicy,
  providers: ProviderInstance[],
  failed: Record<string, number>,
  hops: number,
  now = Date.now(),
): ProviderInstance | undefined {
  if (policy.mode === 'off' || hops >= policy.maxHops) return undefined
  for (const id of policy.fallback) {
    const provider = providers.find((p) => p.id === id && p.status === 'ready')
    if (provider && (failed[id] === undefined || now - failed[id]! >= policy.cooldownMs))
      return provider
  }
  return undefined
}
