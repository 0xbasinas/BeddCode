/**
 * What to do about a turn that has gone quiet. An agent can stay alive but wedged (a stalled
 * request, a deadlock), so its `session/prompt` never answers and the turn would show "working"
 * forever. A crash is already noticed; this covers the silent hang, without capping a turn that is
 * really working or really waiting for the user.
 */

/** How long a turn may go without a sign of work before it is given up on. */
export const DEFAULT_IDLE_MS = 15 * 60_000
/** How often the quiet time is checked. */
export const IDLE_CHECK_MS = 5_000
/** After asking an agent to cancel, how long it has to wrap up before the turn is ended for it. */
export const CANCEL_GRACE_MS = 8_000

export type IdleTick = 'stop' | 'touch' | 'timeout' | 'continue'

/**
 * - `stop`: the turn is over; stop watching,
 * - `touch`: it waits for the user (an approval, a question), which is not a hang; restart the clock,
 * - `timeout`: silent for too long,
 * - `continue`: still within its budget.
 */
export function evaluateIdleTick(input: {
  turnActive: boolean
  awaitingUser: boolean
  idleMs: number
  timeoutMs: number
}): IdleTick {
  if (!input.turnActive) return 'stop'
  if (input.awaitingUser) return 'touch'
  return input.idleMs >= input.timeoutMs ? 'timeout' : 'continue'
}

const positive = (raw: string | undefined, fallback: number) => {
  const parsed = Number(raw?.trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** `BEDDCODE_ACP_IDLE_MS`, ignored when it is empty, not a number or not positive. */
export function idleTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return positive(env.BEDDCODE_ACP_IDLE_MS, DEFAULT_IDLE_MS)
}

export interface IdleTiming {
  timeoutMs: number
  checkMs: number
  graceMs: number
}

/** The three times, each with an environment override (BEDDCODE_ACP_IDLE_MS, _CHECK_MS, _CANCEL_GRACE_MS). */
export function idleTiming(env: Record<string, string | undefined> = process.env): IdleTiming {
  return {
    timeoutMs: idleTimeoutMs(env),
    checkMs: positive(env.BEDDCODE_ACP_CHECK_MS, IDLE_CHECK_MS),
    graceMs: positive(env.BEDDCODE_ACP_CANCEL_GRACE_MS, CANCEL_GRACE_MS),
  }
}

/**
 * Which updates prove the agent is working. Settings, mode, command and usage updates are not
 * proof: they can keep arriving after the agent stopped producing anything.
 */
export function isProgress(sessionUpdate: string): boolean {
  switch (sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
    case 'plan':
      return true
    default:
      return false
  }
}

/**
 * Resuming a conversation (`session/load`) makes some agents replay it as updates, sometimes after
 * the request has answered. The replay is over once it has been quiet for a moment, or when it has
 * gone on too long to wait for.
 */
export function replaySettled(input: {
  now: number
  /** When the last replayed update arrived, or when the load finished if none did. */
  lastActivityAt: number
  startedAt: number
  quietMs: number
  hardMs: number
}): boolean {
  return (
    input.now - input.lastActivityAt >= input.quietMs || input.now - input.startedAt >= input.hardMs
  )
}
