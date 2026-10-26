import type { StoredEvent } from '@beddcode/contracts'

/**
 * Events that each replace what the last one of their kind said, so only the latest of them in a
 * replay matters: the agent's commands, settings and modes, the context meter, and its plan.
 */
export const SUPERSEDED_TYPES: ReadonlySet<string> = new Set([
  'session.commands',
  'session.config',
  'session.modes',
  'session.context',
  'plan.updated',
])

/**
 * Shrinks a replay without changing what it builds. A client that replays the result ends with
 * the same sessions as one that replays every event:
 *  - a superseded event that is not the latest of its kind is left out;
 *  - consecutive pieces of the agent's streamed reply in one turn become one event, keeping the
 *    first piece's seq (it names the message) and the last piece's time.
 * Events stay in seq order. A client must remember where it got to from `caught-up`, not from the
 * last event, because that one may have been joined into an earlier event.
 */
export class ReplayCompactor {
  /** `keep`: the seqs of the latest superseded events in the range being replayed. */
  constructor(private readonly keep: ReadonlySet<number>) {}

  /** Joins only within one batch, so a run split by a batch edge is still correct, just longer. */
  compact(batch: StoredEvent[]): StoredEvent[] {
    const out: StoredEvent[] = []
    const open = new Map<string, { at: number; turnId: string | undefined }>()
    for (const stored of batch) {
      const e = stored.event
      if (SUPERSEDED_TYPES.has(e.type) && !this.keep.has(stored.seq)) continue
      if (e.type === 'message.delta' && e.role === 'assistant') {
        const run = open.get(e.sessionId)
        if (run && run.turnId === e.turnId) {
          const first = out[run.at]!
          if (first.event.type === 'message.delta') {
            out[run.at] = {
              seq: first.seq,
              event: { ...first.event, text: first.event.text + e.text, at: e.at },
            }
            continue
          }
        }
        open.set(e.sessionId, { at: out.length, turnId: e.turnId })
      } else {
        open.delete(e.sessionId)
      }
      out.push(stored)
    }
    return out
  }
}
