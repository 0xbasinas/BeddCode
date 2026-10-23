import type { UsageSummary } from '@beddcode/contracts'
import type { EventStore } from '../store/eventStore.ts'

type Totals = Omit<UsageSummary['totals'], never>
const empty = (): Totals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
})

function add(into: Totals, e: Partial<Totals>) {
  into.inputTokens += e.inputTokens ?? 0
  into.outputTokens += e.outputTokens ?? 0
  into.cacheReadTokens += e.cacheReadTokens ?? 0
  into.cacheWriteTokens += e.cacheWriteTokens ?? 0
  into.costUsd += e.costUsd ?? 0
}

/** Tokens that count towards "how much did this use": everything the model read or wrote. */
export const totalTokens = (t: Totals) =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens

const pad = (n: number) => String(n).padStart(2, '0')
/** The local calendar day of a time, as YYYY-MM-DD. */
export const dayOf = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * What the agents used over the last `days` days (today included), from the usage events they
 * reported. A model nobody named is filed under the agent that ran it.
 */
export function summarizeUsage(
  store: EventStore,
  days: number,
  now = Date.now(),
  agentOf: (instanceId: string) => string = (id) => id,
): UsageSummary {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const since = start.getTime()

  const events = store.usageSince(since)
  const meta = store.sessionMeta([...new Set(events.map((e) => e.sessionId))])

  const totals = empty()
  const byModel = new Map<string, Totals>()
  const bySession = new Map<string, Totals>()
  const byDay = new Map<string, Totals>()
  // Every day of the period appears, so a quiet day is a gap and not a missing bar.
  for (let i = 0; i < days; i++) {
    const day = new Date(start)
    day.setDate(start.getDate() + i)
    byDay.set(dayOf(day.getTime()), empty())
  }

  for (const e of events) {
    add(totals, e)
    const info = meta.get(e.sessionId)
    const model = e.model ?? info?.model ?? (info ? agentOf(info.instanceId) : 'Unknown')
    for (const [map, key] of [
      [byModel, model],
      [bySession, e.sessionId],
      [byDay, dayOf(e.at)],
    ] as const) {
      let entry = map.get(key)
      if (!entry) map.set(key, (entry = empty()))
      add(entry, e)
    }
  }

  const byTokens = (a: Totals, b: Totals) => totalTokens(b) - totalTokens(a)
  return {
    since,
    totals,
    byModel: [...byModel].map(([model, t]) => ({ model, ...t })).sort(byTokens),
    bySession: [...bySession]
      .map(([sessionId, t]) => ({
        sessionId,
        title: meta.get(sessionId)?.title ?? 'Session',
        branch: meta.get(sessionId)?.branch,
        ...t,
      }))
      .sort(byTokens),
    byDay: [...byDay].map(([day, t]) => ({ day, ...t })),
  }
}
