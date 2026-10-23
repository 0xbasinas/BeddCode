import type { UsageWindow } from '@beddcode/contracts'
import type { WithAppServer } from './history.ts'

interface RateWindow {
  usedPercent?: number
  windowDurationMins?: number | null
  /** Unix seconds. */
  resetsAt?: number | null
}

/** `account/rateLimits/read`: the plan, and a short and a long window. */
export interface CodexLimits {
  rateLimits?: {
    planType?: string | null
    primary?: RateWindow | null
    secondary?: RateWindow | null
  }
}

const labelFor = (minutes: number | null | undefined) => {
  if (!minutes) return 'Usage window'
  if (minutes === 300) return '5-hour window'
  if (minutes === 10_080) return 'This week'
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`
  return `${minutes}-minute window`
}

export function codexLimits(response: CodexLimits): {
  plan?: string
  windows: UsageWindow[]
  note?: string
} {
  const limits = response.rateLimits
  if (!limits) return { windows: [], note: 'Codex did not report plan limits for this account.' }
  const windows = [limits.primary, limits.secondary].flatMap((w, i): UsageWindow[] => {
    if (!w || typeof w.usedPercent !== 'number') return []
    return [
      {
        id: i === 0 ? 'primary' : 'secondary',
        label: labelFor(w.windowDurationMins),
        usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
        resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : undefined,
      },
    ]
  })
  return { plan: limits.planType ?? undefined, windows }
}

/** Asks a throwaway `codex app-server` for the account's limits. */
export async function readCodexLimits(withAppServer: WithAppServer) {
  const response = await withAppServer((rpc) =>
    rpc.request<CodexLimits>('account/rateLimits/read', null),
  )
  return codexLimits(response)
}
