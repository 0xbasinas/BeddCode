import type { StoredEvent } from '@beddcode/contracts'
import type { EventStore } from '../store/eventStore.ts'

function track(active: Map<string, { turnId?: string }>, { event }: StoredEvent) {
  if (
    event.type === 'turn.started' ||
    event.type === 'tool.started' ||
    event.type === 'approval.requested'
  ) {
    active.set(event.sessionId, { turnId: event.turnId })
  } else if (event.type === 'turn.completed' || event.type === 'error') {
    active.delete(event.sessionId)
  }
}

/** Provider processes are gone after a host restart. Replaying their last status must not
 * leave the client waiting forever. History and provider resume IDs remain intact. */
export function recoverInterruptedTurns(store: EventStore) {
  const active = new Map<string, { turnId?: string }>()
  let cursor = 0
  for (;;) {
    const events = store.readAfter(cursor, 5000)
    if (!events.length) break
    events.forEach((event) => track(active, event))
    cursor = events.at(-1)!.seq
  }
  for (const [sessionId, { turnId }] of active) {
    store.append({
      type: 'turn.completed',
      sessionId,
      turnId,
      at: Date.now(),
      reason: 'cancelled',
      message:
        'The host restarted before this turn finished. Send a message to continue this session.',
    })
  }
}
