import type { StoredEvent } from '@beddcode/contracts'
import type { EventStore } from '../store/eventStore.ts'

const pendingResume = new Map<string, { turnId?: string; prompt: { text: string; attachments: { name: string; path: string }[] } }>()

function track(active: Map<string, { turnId?: string; at: number }>, { event }: StoredEvent) {
  if (
    event.type === 'turn.started' ||
    event.type === 'tool.started' ||
    event.type === 'approval.requested'
  ) {
    active.set(event.sessionId, { turnId: event.turnId, at: event.at })
  } else if (event.type === 'turn.completed' || event.type === 'error') {
    active.delete(event.sessionId)
  }
}

/** Provider processes are gone after a host restart. Replaying their last status must not
 * leave the client waiting forever. History and provider resume IDs remain intact. */
export function recoverInterruptedTurns(store: EventStore): string[] {
  pendingResume.clear()
  const active = new Map<string, { turnId?: string; at: number }>()
  const updating = new Map<string, Extract<StoredEvent['event'], { type: 'host.updating' }>>()
  const createdAt = new Map<string, number>()
  let cursor = 0
  for (;;) {
    const events = store.readAfter(cursor, 5000)
    if (!events.length) break
    for (const stored of events) {
      const event = stored.event
      track(active, stored)
      if (event.type === 'session.created') createdAt.set(event.sessionId, event.at)
      if (event.type === 'host.updating') updating.set(event.sessionId, event)
      if (event.type === 'turn.completed' || event.type === 'error') updating.delete(event.sessionId)
    }
    cursor = events.at(-1)!.seq
  }
  const resume: string[] = []
  for (const [sessionId, { turnId, at }] of active) {
    const marker = updating.get(sessionId)
    const marked = marker !== undefined && at >= (createdAt.get(sessionId) ?? 0)
    if (marked && marker) {
      resume.push(sessionId)
      // The marker is the durable resume record. SessionManager handles provider setup.
      pendingResume.set(sessionId, { turnId, prompt: marker.prompt })
      updating.delete(sessionId)
      continue
    }
    store.append({
      type: 'turn.completed',
      sessionId,
      turnId,
      at: Date.now(),
      reason: 'cancelled',
      message: marked
        ? 'The host restarted, but this agent could not resume the interrupted turn. Send a message to continue this session.'
        : 'The host restarted before this turn finished. Send a message to continue this session.',
    })
  }
  return resume
}

export function takeInterruptedSessions() {
  const sessions = [...pendingResume].map(([sessionId, saved]) => ({ sessionId, ...saved }))
  pendingResume.clear()
  return sessions
}
