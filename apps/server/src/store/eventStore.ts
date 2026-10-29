import { mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionEvent, type StoredEvent } from '@beddcode/contracts'
import { createLogger, type Logger } from '@beddcode/shared'
import { migrations } from './migrations.ts'
import { SUPERSEDED_TYPES } from './compact.ts'
import { isSnapshot, snapshotKey } from './snapshots.ts'

export type EventListener = (stored: StoredEvent) => void

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * Parses one stored row. A row that no longer parses (written by a newer or older version, or
 * damaged on disk) is skipped rather than failing the whole read: one bad event must not stop
 * every device from catching up, or the host from starting.
 */
function parseRow(row: { seq: number; payload: string }, log: Logger): StoredEvent | null {
  try {
    return { seq: row.seq, event: SessionEvent.parse(JSON.parse(row.payload)) }
  } catch (err) {
    log.warn(
      `skipping unreadable event ${row.seq}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
    )
    return null
  }
}

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
  private notificationBatch: StoredEvent[] | null = null
  /** Identifies this log; a new database has a new one. Devices check it before trusting a saved copy. */
  readonly logId: string
  /** The latest commands/config/modes event per session and type, to skip unchanged repeats. */
  private readonly snapshots = new Map<string, { seq: number; key: string }>()

  private readonly log: Logger
  /** Rows already reported as unreadable, so each is logged once. */
  private readonly badRows = new Set<number>()

  /** `file` is a path, or ':memory:' for tests. */
  constructor(
    private readonly file: string,
    log: Logger = createLogger('store'),
  ) {
    this.log = log
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    try {
      if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
      // The CLI and the host can open the same database; wait for a lock instead of failing at once.
      this.db.exec('PRAGMA busy_timeout = 5000')
      this.migrate()
    } catch (err) {
      // Let go of the file, so a damaged one can be moved aside (Windows refuses while it is open).
      this.db.close()
      throw err
    }
    this.logId = (
      this.db.prepare("SELECT value FROM meta WHERE key = 'logId'").get() as { value: string }
    ).value
    this.insert = this.db.prepare(
      'INSERT INTO events (session_id, type, at, payload) VALUES (?, ?, ?, ?) RETURNING seq',
    )
    this.readStmt = this.db.prepare(
      'SELECT seq, payload FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?',
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
    if (row.user_version > migrations.length) {
      // An older BeddCode after a newer one: the log stays readable (unknown events are skipped),
      // but say why some history may be missing until BeddCode is updated again.
      this.log.warn(
        `the history database was last used by a newer BeddCode (schema ${row.user_version}, this version knows ${migrations.length}); events this version does not know are skipped`,
      )
    }
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
    return this.writeEvent(SessionEvent.parse(event))
  }

  /** One durable transaction for an imported burst; listeners only see committed events. */
  appendMany(events: SessionEvent[]): StoredEvent[] {
    if (!events.length) return []
    const parsed = events.map((event) => SessionEvent.parse(event))
    const notifications: StoredEvent[] = []
    this.db.exec('BEGIN')
    this.notificationBatch = notifications
    let stored: StoredEvent[]
    try {
      stored = parsed.map((event) => this.writeEvent(event))
      this.db.exec('COMMIT')
    } catch (err) {
      // SQLite may already have rolled back (a full disk does); that must not hide the reason.
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // no transaction left
      }
      this.snapshots.clear()
      throw storageError(err, this.file)
    } finally {
      this.notificationBatch = null
    }
    for (const event of notifications) this.notify(event)
    return stored
  }

  private writeEvent(parsed: SessionEvent): StoredEvent {
    let snapshot: { slot: string; key: string } | undefined
    if (isSnapshot(parsed)) {
      const slot = `${parsed.sessionId}\n${parsed.type}`
      const key = snapshotKey(parsed)
      const previous = this.snapshots.get(slot) ?? this.loadSnapshot(parsed.sessionId, parsed.type)
      if (previous?.key === key) return { seq: previous.seq, event: parsed }
      snapshot = { slot, key }
    }
    let row: { seq: number }
    try {
      row = this.insert.get(parsed.sessionId, parsed.type, parsed.at, JSON.stringify(parsed)) as {
        seq: number
      }
    } catch (err) {
      throw storageError(err, this.file)
    }
    const stored: StoredEvent = { seq: row.seq, event: parsed }
    if (snapshot) this.snapshots.set(snapshot.slot, { seq: row.seq, key: snapshot.key })
    if (this.notificationBatch) this.notificationBatch.push(stored)
    else this.notify(stored)
    return stored
  }

  /**
   * Tells every listener. The event is already committed, so a listener that throws (a client
   * socket gone bad, an automation bug) must neither fail the append nor starve the others.
   */
  private notify(stored: StoredEvent) {
    for (const listener of this.listeners) {
      try {
        listener(stored)
      } catch (err) {
        this.log.error(`event listener failed on ${stored.event.type} (seq ${stored.seq})`, err)
      }
    }
  }

  private loadSnapshot(sessionId: string, type: string) {
    const row = this.lastSnapshotStmt.get(sessionId, type) as
      { seq: number; payload: string } | undefined
    if (!row) return undefined
    let key: string
    try {
      key = snapshotKey(JSON.parse(row.payload))
    } catch {
      return undefined
    }
    const found = { seq: row.seq, key }
    this.snapshots.set(`${sessionId}\n${type}`, found)
    return found
  }

  /** Events with seq greater than `afterSeq`, oldest first. */
  readAfter(afterSeq: number, limit = 1000, throughSeq = Number.MAX_SAFE_INTEGER): StoredEvent[] {
    const rows = this.readStmt.all(afterSeq, throughSeq, limit) as {
      seq: number
      payload: string
    }[]
    return this.parseRows(rows)
  }

  private parseRows(rows: { seq: number; payload: string }[]): StoredEvent[] {
    const out: StoredEvent[] = []
    for (const row of rows) {
      const parsed = parseRow(row, this.badRows.has(row.seq) ? silent : this.log)
      if (parsed) out.push(parsed)
      else this.badRows.add(row.seq)
    }
    return out
  }

  /**
   * The seq of the latest event of each state-like type (commands, settings, context, plan) per
   * session after `afterSeq`. Earlier ones in that range say nothing that a later one does not.
   */
  latestStateSeqs(afterSeq: number, throughSeq = Number.MAX_SAFE_INTEGER): Set<number> {
    const types = [...SUPERSEDED_TYPES]
    const rows = this.db
      .prepare(
        `SELECT MAX(seq) AS seq FROM events WHERE seq > ? AND seq <= ? AND type IN (${types.map(() => '?').join(', ')}) GROUP BY session_id, type`,
      )
      .all(afterSeq, throughSeq, ...types) as { seq: number }[]
    return new Set(rows.map((r) => r.seq))
  }

  /** Every event of one session, oldest first. Used to rebuild a session's identity on resume. */
  readSession(sessionId: string): StoredEvent[] {
    const rows = this.bySessionStmt.all(sessionId) as { seq: number; payload: string }[]
    return this.parseRows(rows)
  }

  /** Removes a session's events before `beforeSeq`; the log keeps its numbers, with a gap. */
  purgeSession(sessionId: string, beforeSeq: number): void {
    this.db.prepare('DELETE FROM events WHERE session_id = ? AND seq < ?').run(sessionId, beforeSeq)
    for (const slot of [...this.snapshots.keys()]) {
      if (
        slot.startsWith(`${sessionId}
`)
      )
        this.snapshots.delete(slot)
    }
  }

  /** Every usage report made at or after `since`, oldest first. */
  usageSince(since: number): Extract<SessionEvent, { type: 'session.usage' }>[] {
    const rows = this.db
      .prepare(
        "SELECT seq, payload FROM events WHERE type = 'session.usage' AND at >= ? ORDER BY seq",
      )
      .all(since) as { seq: number; payload: string }[]
    return this.parseRows(rows).map(
      (r) => r.event as Extract<SessionEvent, { type: 'session.usage' }>,
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
      "SELECT seq, payload FROM events WHERE session_id = ? AND type IN ('session.created', 'session.renamed', 'session.model') ORDER BY seq",
    )
    for (const id of sessionIds) {
      for (const { event: e } of this.parseRows(
        created.all(id) as { seq: number; payload: string }[],
      )) {
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

  /** Sessions another session's agent started, oldest first. */
  childrenOf(parentSessionId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT session_id AS id FROM events WHERE type = 'session.created' AND json_extract(payload, '$.parent.sessionId') = ? ORDER BY seq",
      )
      .all(parentSessionId) as { id: string }[]
    return rows.map((r) => r.id)
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

/** SQLite's primary result codes this store explains. */
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6
const SQLITE_READONLY = 8
const SQLITE_IOERR = 10
const SQLITE_FULL = 13

/** A write the database refused, with what the user can do about it. */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly reason: 'full' | 'busy' | 'read-only' | 'io',
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'StorageError'
  }
}

/**
 * Turns SQLite's terse write errors into ones that say what is wrong and what to do: they reach
 * the user as the answer to whatever they were doing (sending a message, creating a session).
 */
export function storageError(err: unknown, file: string): unknown {
  if (err instanceof StorageError) return err
  const code = (err as { errcode?: number }).errcode
  if (typeof code !== 'number') return err
  const where = file === ':memory:' ? 'its data folder' : path.dirname(file)
  const detail = err instanceof Error ? err.message : String(err)
  switch (code & 0xff) {
    case SQLITE_FULL:
      return new StorageError(
        `The disk BeddCode saves to is full, so nothing new can be saved (${where}). Free up some space there and try again; nothing needs restarting.`,
        'full',
        { cause: err },
      )
    case SQLITE_BUSY:
    case SQLITE_LOCKED:
      return new StorageError(
        `BeddCode's database is busy: another program is holding it (another BeddCode host using ${where}?). Try again in a moment.`,
        'busy',
        { cause: err },
      )
    case SQLITE_READONLY:
      return new StorageError(
        `BeddCode cannot save to its database: ${file} or its folder is read-only. Check the permissions of ${where}.`,
        'read-only',
        { cause: err },
      )
    case SQLITE_IOERR:
      return new StorageError(
        `BeddCode could not save to its database: the disk reported an error (${detail}). Check the disk that holds ${where}.`,
        'io',
        { cause: err },
      )
    default:
      return err
  }
}

/**
 * Opens the host's event log. A database file that SQLite cannot read at all (cut short by a
 * crash or a full disk, or overwritten) is moved aside, with its journal, and a new log starts:
 * the host comes up with no history instead of not coming up. Devices see the new log id and
 * start over. Other failures (permissions, a disk that is still full) are thrown as they are.
 */
export function openEventStore(file: string, log: Logger = createLogger('store')): EventStore {
  try {
    return new EventStore(file, log)
  } catch (err) {
    const text =
      err instanceof Error ? `${err.message} ${(err as { code?: string }).code ?? ''}` : String(err)
    if (!/not a database|malformed|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(text)) throw err
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const kept = `${file}.corrupt-${stamp}`
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        renameSync(file + suffix, kept + suffix)
      } catch {
        // not there
      }
    }
    log.error(
      `${file} is damaged (${err instanceof Error ? err.message : String(err)}); starting a new history. The old file was kept as ${kept}.`,
    )
    return new EventStore(file, log)
  }
}
