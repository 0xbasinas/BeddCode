/** Append-only: never edit a shipped migration, add a new one. Applied in order via user_version. */
export const migrations: string[] = [
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
]
