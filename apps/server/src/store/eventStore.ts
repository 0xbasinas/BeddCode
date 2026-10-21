import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionEvent, type StoredEvent } from '@beddcode/contracts'
import { migrations } from './migrations.ts'

export type EventListener = (stored: StoredEvent) => void

/**
 * Durable, append-only log of every session event. Events are committed before listeners run,
 * so anything a client sees live can also be replayed after a reconnect.
 */
export class EventStore {
  private readonly db: DatabaseSync
  private readonly insert
  private readonly readStmt
  private readonly lastSeqStmt
  private readonly bySessionStmt
  private readonly listeners = new Set<EventListener>()

  /** `file` is a path, or ':memory:' for tests. */
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
    this.insert = this.db.prepare(
      'INSERT INTO events (session_id, type, at, payload) VALUES (?, ?, ?, ?) RETURNING seq',
    )
    this.readStmt = this.db.prepare(
      'SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
    )
    this.bySessionStmt = this.db.prepare(
      'SELECT seq, payload FROM events WHERE session_id = ? ORDER BY seq',
    )
    this.lastSeqStmt = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events')
  }

  private migrate() {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = row.user_version; v < migrations.length; v++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(migrations[v] as string)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  append(event: SessionEvent): StoredEvent {
    const parsed = SessionEvent.parse(event)
    const row = this.insert.get(
      parsed.sessionId,
      parsed.type,
      parsed.at,
      JSON.stringify(parsed),
    ) as { seq: number }
    const stored: StoredEvent = { seq: row.seq, event: parsed }
    for (const listener of this.listeners) listener(stored)
    return stored
  }

  /** Events with seq greater than `afterSeq`, oldest first. */
  readAfter(afterSeq: number, limit = 1000): StoredEvent[] {
    const rows = this.readStmt.all(afterSeq, limit) as { seq: number; payload: string }[]
    return rows.map((r) => ({ seq: r.seq, event: SessionEvent.parse(JSON.parse(r.payload)) }))
  }

  /** Every event of one session, oldest first. Used to rebuild a session's identity on resume. */
  readSession(sessionId: string): StoredEvent[] {
    const rows = this.bySessionStmt.all(sessionId) as { seq: number; payload: string }[]
    return rows.map((r) => ({ seq: r.seq, event: SessionEvent.parse(JSON.parse(r.payload)) }))
  }

  lastSeq(): number {
    return (this.lastSeqStmt.get() as { seq: number }).seq
  }

  /** Live events committed after this call. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    this.db.close()
  }
}
