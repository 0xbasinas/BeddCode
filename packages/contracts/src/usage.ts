import { z } from 'zod'

const Tokens = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  /** Cost the agent reported, summed; zero when none of it reports cost. */
  costUsd: z.number(),
})

/** What the agents used on one host over a period, from the events they reported. */
export const UsageSummary = z.object({
  /** Start of the period, epoch ms. */
  since: z.number(),
  totals: Tokens,
  byModel: z.array(Tokens.extend({ model: z.string() })),
  bySession: z.array(
    Tokens.extend({
      sessionId: z.string(),
      title: z.string(),
      /** The branch the session worked on, when it had one. */
      branch: z.string().optional(),
    }),
  ),
  /** One entry per local calendar day in the period, oldest first. */
  byDay: z.array(Tokens.extend({ day: z.string() })),
})
export type UsageSummary = z.infer<typeof UsageSummary>

/** One window of a plan's limits: how much is used and when it starts over. */
export const UsageWindow = z.object({
  id: z.string(),
  label: z.string(),
  /** 0 to 100. */
  usedPercent: z.number(),
  resetsAt: z.number().optional(),
})
export type UsageWindow = z.infer<typeof UsageWindow>

/** What one agent says about its plan: only agents that report limits appear with windows. */
export const UsageLimits = z.object({
  instanceId: z.string(),
  label: z.string(),
  /** The plan, as the agent names it ("pro", "max"). */
  plan: z.string().optional(),
  windows: z.array(UsageWindow),
  /** Why there is nothing to show: not signed in with a plan, or the agent cannot say. */
  note: z.string().optional(),
})
export type UsageLimits = z.infer<typeof UsageLimits>
