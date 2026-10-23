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
]
