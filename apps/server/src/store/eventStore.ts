import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionEvent, type StoredEvent } from '@beddcode/contracts'
import { migrations } from './migrations.ts'
import { isSnapshot, snapshotKey } from './snapshots.ts'

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
  private readonly lastSnapshotStmt
  private readonly listeners = new Set<EventListener>()
  /** The latest commands/config/modes event per session and type, to skip unchanged repeats. */
  private readonly snapshots = new Map<string, { seq: number; key: string }>()

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
    this.lastSnapshotStmt = this.db.prepare(
      'SELECT seq, payload FROM events WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1',
    )
  }

  private migrate() {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = row.user_version; v < migrations.length; v++) {
      this.db.exec('BEGIN')
      try {
        const step = migrations[v]!
        if (typeof step === 'string') this.db.exec(step)
        else step(this.db)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  /**
   * Commits an event and tells listeners. A commands/config/modes event identical to the session's
   * previous one is not stored or sent again; the stored original is returned instead.
   */
  append(event: SessionEvent): StoredEvent {
    const parsed = SessionEvent.parse(event)
    let snapshot: { slot: string; key: string } | undefined
    if (isSnapshot(parsed)) {
      const slot = `${parsed.sessionId}\n${parsed.type}`
      const key = snapshotKey(parsed)
      const previous = this.snapshots.get(slot) ?? this.loadSnapshot(parsed.sessionId, parsed.type)
      if (previous?.key === key) return { seq: previous.seq, event: parsed }
      snapshot = { slot, key }
    }
    const row = this.insert.get(
      parsed.sessionId,
      parsed.type,
      parsed.at,
      JSON.stringify(parsed),
    ) as { seq: number }
    const stored: StoredEvent = { seq: row.seq, event: parsed }
    if (snapshot) this.snapshots.set(snapshot.slot, { seq: row.seq, key: snapshot.key })
    for (const listener of this.listeners) listener(stored)
    return stored
  }

  private loadSnapshot(sessionId: string, type: string) {
    const row = this.lastSnapshotStmt.get(sessionId, type) as
      { seq: number; payload: string } | undefined
    if (!row) return undefined
    const found = { seq: row.seq, key: snapshotKey(JSON.parse(row.payload)) }
    this.snapshots.set(`${sessionId}\n${type}`, found)
    return found
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

  /** Every usage report made at or after `since`, oldest first. */
  usageSince(since: number): Extract<SessionEvent, { type: 'session.usage' }>[] {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE type = 'session.usage' AND at >= ? ORDER BY seq")
      .all(since) as { payload: string }[]
    return rows.map(
      (r) =>
        SessionEvent.parse(JSON.parse(r.payload)) as Extract<
          SessionEvent,
          { type: 'session.usage' }
        >,
    )
  }

  /** What the log says about sessions: their name, branch, agent and the model they were started with. */
  sessionMeta(
    sessionIds: string[],
  ): Map<string, { title: string; branch?: string; instanceId: string; model?: string }> {
    const out = new Map<
      string,
      { title: string; branch?: string; instanceId: string; model?: string }
    >()
    const created = this.db.prepare(
      "SELECT payload FROM events WHERE session_id = ? AND type IN ('session.created', 'session.renamed', 'session.model') ORDER BY seq",
    )
    for (const id of sessionIds) {
      for (const row of created.all(id) as { payload: string }[]) {
        const e = SessionEvent.parse(JSON.parse(row.payload))
        if (e.type === 'session.created') {
          out.set(id, {
            title: e.title,
            branch: e.branch,
            instanceId: e.instanceId,
            model: e.model,
          })
        } else if (e.type === 'session.renamed') {
          const current = out.get(id)
          if (current) current.title = e.title
        } else if (e.type === 'session.model') {
          const current = out.get(id)
          if (current && e.model) current.model = e.model
        }
      }
    }
    return out
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
