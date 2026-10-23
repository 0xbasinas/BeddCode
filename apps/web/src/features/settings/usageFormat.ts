import type { UsageSummary } from '@beddcode/contracts'

type Counts = Pick<
  UsageSummary['totals'],
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
>

/** Everything the model read or wrote; what "how much did this use" means in the lists. */
export const tokensOf = (t: Counts) =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens

/** 950 tokens, 184k tokens, 1.3M tokens. */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k tokens`
  return `${(n / 1_000_000).toFixed(1)}M tokens`
}

/** "Resets in 2h 10m" within a day, "Resets Monday" after that, nothing when unknown. */
export function formatReset(resetsAt: number | undefined, now = Date.now()): string | undefined {
  if (resetsAt === undefined) return undefined
  const ms = resetsAt - now
  if (ms <= 0) return 'Resetting now'
  const minutes = Math.round(ms / 60_000)
  if (ms < 24 * 3_600_000) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return `Resets in ${h > 0 ? `${h}h ` : ''}${m}m`
  }
  return `Resets ${new Date(resetsAt).toLocaleDateString(undefined, { weekday: 'long' })}`
}

/** Each row's share of the largest row, 0 to 100, for drawing bars. */
export function shares<T>(rows: T[], valueOf: (row: T) => number): number[] {
  const max = Math.max(0, ...rows.map(valueOf))
  return rows.map((row) => (max === 0 ? 0 : Math.round((valueOf(row) / max) * 100)))
}

/** Each row's share of the total, as whole percents (they may not add to exactly 100). */
export function percentOfTotal<T>(rows: T[], valueOf: (row: T) => number): number[] {
  const total = rows.reduce((sum, row) => sum + valueOf(row), 0)
  return rows.map((row) => (total === 0 ? 0 : Math.round((valueOf(row) / total) * 100)))
}

/** A plan name as the agents spell it ("pro", "promax") for reading. */
export function planName(plan: string | undefined): string | undefined {
  if (!plan) return undefined
  const known: Record<string, string> = {
    promax: 'Pro Max',
    prolite: 'Pro Lite',
    max: 'Max',
    pro: 'Pro',
    plus: 'Plus',
    team: 'Team',
    enterprise: 'Enterprise',
    free: 'Free',
  }
  return known[plan.toLowerCase()] ?? plan.charAt(0).toUpperCase() + plan.slice(1)
}
