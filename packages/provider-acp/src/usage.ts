import type { SessionEvent } from '@beddcode/contracts'

type Obj = Record<string, unknown>

/** What a turn used, for one model; becomes a `session.usage` event. */
export interface TurnUsage {
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd?: number
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0

const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined

/** xAI prices in "ticks": ten billion to the dollar. */
const USD_PER_TICK = 1e-10

/**
 * One block of counts in either spelling agents use: the protocol's (`cachedReadTokens`,
 * `cachedWriteTokens`) or the same with `cacheCreationTokens`. Input is counted with the cached
 * part included, so the cached part is taken out of it to keep the two apart.
 */
function counts(u: Obj, model?: string): TurnUsage | undefined {
  const cacheRead = num(u.cachedReadTokens ?? u.cacheReadTokens ?? u.cachedInputTokens)
  const cacheWrite = num(u.cachedWriteTokens ?? u.cacheCreationTokens ?? u.cacheWriteTokens)
  const input = Math.max(0, num(u.inputTokens) - cacheRead)
  const output = num(u.outputTokens)
  if (input + output + cacheRead + cacheWrite === 0) return undefined
  const cost = num(u.costUsdTicks) * USD_PER_TICK || (typeof u.costUsd === 'number' ? u.costUsd : 0)
  return {
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    costUsd: cost > 0 ? cost : undefined,
  }
}

/**
 * The usage an agent reports with the end of a prompt turn. The protocol has a `usage` field on the
 * response; agents that report more (per-model counts, cost) put it under `_meta`. Anything an
 * agent does not report is simply absent: no report, no usage event.
 */
export function promptUsage(response: unknown): TurnUsage[] {
  const res = obj(response)
  if (!res) return []
  const meta = obj(res._meta)
  const fromMeta = obj(meta?.usage)

  // Per-model counts, when the agent gives them.
  const perModel = obj(fromMeta?.modelUsage)
  if (perModel) {
    const rows = Object.entries(perModel).flatMap(([model, u]) => {
      const row = obj(u) && counts(obj(u)!, model)
      return row ? [row] : []
    })
    if (rows.length > 0) return rows
  }

  const modelId = typeof meta?.modelId === 'string' ? meta.modelId : undefined
  for (const block of [fromMeta, obj(res.usage), meta]) {
    const row = block && counts(block, modelId)
    if (row) return [row]
  }
  return []
}

export function usageEvents(
  usage: TurnUsage[],
): Omit<Extract<SessionEvent, { type: 'session.usage' }>, 'sessionId' | 'at' | 'turnId'>[] {
  return usage.map((u) => ({
    type: 'session.usage' as const,
    model: u.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    costUsd: u.costUsd,
  }))
}
