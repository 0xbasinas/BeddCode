import type { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '@beddcode/contracts'

/**
 * Events that describe the session's current state (the agent's commands, settings and modes)
 * rather than something that happened. Agents send them again and again, mostly unchanged.
 */
export const SNAPSHOT_TYPES = ['session.commands', 'session.config', 'session.modes'] as const
export type SnapshotType = (typeof SNAPSHOT_TYPES)[number]

export const isSnapshot = (
  event: SessionEvent,
): event is Extract<SessionEvent, { type: SnapshotType }> =>
  (SNAPSHOT_TYPES as readonly string[]).includes(event.type)

/** What a snapshot says, without when or in which turn it was said. */
export function snapshotKey(event: Record<string, unknown>): string {
  const { at: _at, turnId: _turnId, sessionId: _sessionId, ...rest } = event
  return JSON.stringify(rest)
}

/**
 * Deletes snapshot events that repeat the session's previous one of the same type exactly.
 * Replaying the log gives the same state without them. Returns how many rows went.
 */
export function dropRepeatedSnapshots(db: DatabaseSync): number {
  const placeholders = SNAPSHOT_TYPES.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT seq, session_id, type, payload FROM events WHERE type IN (${placeholders}) ORDER BY seq`,
    )
    .all(...SNAPSHOT_TYPES) as { seq: number; session_id: string; type: string; payload: string }[]
  const last = new Map<string, string>()
  const repeats: number[] = []
  for (const row of rows) {
    let key: string
    try {
      key = snapshotKey(JSON.parse(row.payload) as Record<string, unknown>)
    } catch {
      continue
    }
    const slot = `${row.session_id}\n${row.type}`
    if (last.get(slot) === key) repeats.push(row.seq)
    else last.set(slot, key)
  }
  const del = db.prepare('DELETE FROM events WHERE seq = ?')
  for (const seq of repeats) del.run(seq)
  return repeats.length
}
