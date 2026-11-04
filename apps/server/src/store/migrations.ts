import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { dropRepeatedSnapshots } from './snapshots.ts'

/**
 * Append-only: never edit a shipped migration, add a new one. Applied in order via user_version,
 * each inside a transaction. A function runs against the open database.
 */
export const migrations: (string | ((db: DatabaseSync) => void))[] = [
  `
  CREATE TABLE events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    at         INTEGER NOT NULL,
    payload    TEXT    NOT NULL
  );
  CREATE INDEX events_session ON events (session_id, seq);
  `,
  // Usage and similar reports read one kind of event over a period.
  `
  CREATE INDEX events_type_at ON events (type, at);
  `,
  // Agents re-send the same command list (and settings, modes) many times per session; only
  // changes are kept from now on, so the old repeats go too. Replaying them changed nothing.
  (db) => {
    dropRepeatedSnapshots(db)
  },
  // Which log this is, so a device that saved its copy of the history can tell when the host's
  // database was replaced and the copy is no longer valid.
  (db) => {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare("INSERT INTO meta (key, value) VALUES ('logId', ?)").run(randomUUID())
  },
  `
  ALTER TABLE events ADD COLUMN session_seq INTEGER;
  WITH numbered AS (SELECT seq, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq) AS n FROM events)
  UPDATE events SET session_seq = (SELECT n FROM numbered WHERE numbered.seq = events.seq);
  CREATE UNIQUE INDEX events_session_seq ON events (session_id, session_seq);
  CREATE TABLE session_cursors (session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
  INSERT INTO session_cursors SELECT session_id, MAX(session_seq) FROM events GROUP BY session_id;
  CREATE TRIGGER events_cursor AFTER INSERT ON events BEGIN
    INSERT INTO session_cursors (session_id, seq) VALUES (NEW.session_id, NEW.session_seq)
    ON CONFLICT(session_id) DO UPDATE SET seq = excluded.seq;
  END;
  `,
  `
  CREATE TABLE peer_sends (project TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX peer_sends_project_at ON peer_sends (project, at);
  `,
  `
  CREATE TABLE peer_thread_sends (thread_id TEXT NOT NULL, message_id TEXT PRIMARY KEY);
  CREATE INDEX peer_thread_sends_thread ON peer_thread_sends (thread_id);
  INSERT OR IGNORE INTO peer_thread_sends (thread_id, message_id)
    SELECT json_extract(payload, '$.threadId'), json_extract(payload, '$.messageId')
    FROM events WHERE type = 'agent.message' AND json_valid(payload)
      AND json_type(payload, '$.threadId') = 'text' AND json_type(payload, '$.messageId') = 'text';
  `,
  `
  CREATE TABLE peer_outbox (
    message_id TEXT PRIMARY KEY, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE peer_receipts (message_id TEXT PRIMARY KEY);
  `,
  // Generic jobs live alongside session events and survive event compaction.
  `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, project TEXT, payload TEXT NOT NULL,
    state TEXT NOT NULL, position INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    lease_token TEXT, lease_until INTEGER, error TEXT
  );
  CREATE INDEX jobs_state_position ON jobs (state, position);
  `,
]
