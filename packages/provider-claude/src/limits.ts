import type { UsageWindow } from '@beddcode/contracts'
import type { QueryFn } from './session.ts'

type Window = { utilization: number | null; resets_at: string | null }

/** The part of the SDK's (experimental) /usage answer this reads. */
export interface ClaudeUsage {
  subscription_type?: string | null
  rate_limits_available?: boolean
  rate_limits?: {
    five_hour?: Window | null
    seven_day?: Window | null
    seven_day_opus?: Window | null
    seven_day_sonnet?: Window | null
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[]
  } | null
}

function windowRow(id: string, label: string, w: Window | null | undefined): UsageWindow[] {
  if (!w || typeof w.utilization !== 'number') return []
  const resetsAt = w.resets_at ? Date.parse(w.resets_at) : NaN
  return [
    {
      id,
      label,
      usedPercent: Math.min(100, Math.max(0, w.utilization)),
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
    },
  ]
}

/** The plan and its windows from the SDK's answer; a note says why there are none. */
export function claudeLimits(usage: ClaudeUsage): {
  plan?: string
  windows: UsageWindow[]
  note?: string
} {
  const plan = usage.subscription_type ?? undefined
  const limits = usage.rate_limits
  if (!usage.rate_limits_available || !limits) {
    return {
      plan,
      windows: [],
      note: 'Plan limits are only shown for Claude accounts with a subscription (not API keys).',
    }
  }
  const windows = [
    ...windowRow('five-hour', '5-hour window', limits.five_hour),
    ...windowRow('week', 'This week', limits.seven_day),
    ...windowRow('week-opus', 'Opus this week', limits.seven_day_opus),
    ...windowRow('week-sonnet', 'Sonnet this week', limits.seven_day_sonnet),
    ...(limits.model_scoped ?? []).flatMap((m, i) =>
      windowRow(`week-model-${i}`, `${m.display_name} this week`, m),
    ),
  ]
  return { plan, windows }
}

/**
 * Asks Claude Code for the plan's limits with a throwaway query that is never sent a prompt. The
 * answer comes from Anthropic's usage endpoint through the CLI, so it takes a couple of seconds.
 */
export async function readClaudeLimits(
  queryFn: QueryFn,
  options: { cwd?: string; executablePath?: string; env?: Record<string, string> },
  timeoutMs = 25_000,
) {
  // A prompt stream that never yields: the CLI starts, answers the control request, and waits.
  const idle: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
  }
  const q = queryFn({
    prompt: idle as never,
    options: {
      cwd: options.cwd ?? process.cwd(),
      settingSources: [],
      ...(options.executablePath ? { pathToClaudeCodeExecutable: options.executablePath } : {}),
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    },
  } as never) as unknown as {
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(o: {
      skipBehaviors: boolean
    }): Promise<ClaudeUsage>
    close(): void
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const usage = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Claude did not answer in time')), timeoutMs)
      }),
    ])
    return claudeLimits(usage)
  } finally {
    clearTimeout(timer)
    q.close()
  }
}
