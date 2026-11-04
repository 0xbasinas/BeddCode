import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type JobState = 'queued' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled'
export interface Job {
  id: string
  kind: string
  project: string | null
  payload: unknown
  state: JobState
  position: number
  attempts: number
  createdAt: number
  updatedAt: number
  leaseToken: string | null
  leaseUntil: number | null
  error: string | null
}
type Row = {
  id: string
  kind: string
  project: string | null
  payload: string
  state: JobState
  position: number
  attempts: number
  created_at: number
  updated_at: number
  lease_token: string | null
  lease_until: number | null
  error: string | null
}
const job = (r: Row): Job => ({
  id: r.id,
  kind: r.kind,
  project: r.project,
  payload: JSON.parse(r.payload),
  state: r.state,
  position: r.position,
  attempts: r.attempts,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  leaseToken: r.lease_token,
  leaseUntil: r.lease_until,
  error: r.error,
})

/** Synchronous SQLite operations. A lease token fences stale workers after recovery or expiry. */
export class DurableJobs {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  enqueue(
    input: { kind: string; payload: unknown; project?: string; id?: string },
    now = Date.now(),
  ): Job {
    const payload = JSON.stringify(input.payload)
    if (!input.kind || payload === undefined) throw new Error('A job needs a kind and JSON payload')
    const id = input.id ?? randomUUID()
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, project, payload, state, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', (SELECT COALESCE(MAX(position), 0) + 1 FROM jobs), ?, ?)`,
      )
      .run(id, input.kind, input.project ?? null, payload, now, now)
    return this.get(id)!
  }
  get(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined
    return row && job(row)
  }
  list(): Job[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY position, id').all() as Row[]).map(job)
  }

  /** Call once when the host starts, before workers are started. Interrupted work is never replayed automatically. */
  recover(now = Date.now()): number {
    return Number(
      this.db
        .prepare(
          "UPDATE jobs SET state = 'interrupted', lease_token = NULL, lease_until = NULL, updated_at = ? WHERE state = 'running'",
        )
        .run(now).changes,
    )
  }
  /** Expired workers cannot finish their old lease. An operator may retry interrupted jobs. */
  expire(now = Date.now()): number {
    return Number(
      this.db
        .prepare(
          "UPDATE jobs SET state = 'interrupted', lease_token = NULL, lease_until = NULL, updated_at = ? WHERE state = 'running' AND lease_until <= ?",
        )
        .run(now, now).changes,
    )
  }
  claim(
    options: { kinds: string[]; leaseMs: number; hostLimit: number; projectLimit: number },
    now = Date.now(),
  ): Job | undefined {
    if (!options.kinds.length) return undefined
    if (
      !Number.isSafeInteger(options.leaseMs) ||
      options.leaseMs <= 0 ||
      !Number.isSafeInteger(options.hostLimit) ||
      options.hostLimit < 1 ||
      !Number.isSafeInteger(options.projectLimit) ||
      options.projectLimit < 1
    )
      throw new Error('Invalid job lease or concurrency limit')
    return this.transaction(() => {
      this.expire(now)
      const running = this.db
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE state = 'running'")
        .get() as { count: number }
      if (running.count >= options.hostLimit) return undefined
      const placeholders = options.kinds.map(() => '?').join(',')
      const row = this.db
        .prepare(
          `SELECT j.* FROM jobs j WHERE j.state = 'queued' AND j.kind IN (${placeholders}) AND
        (j.project IS NULL OR (SELECT COUNT(*) FROM jobs r WHERE r.state = 'running' AND r.project = j.project) < ?)
        ORDER BY j.position, j.id LIMIT 1`,
        )
        .get(...options.kinds, options.projectLimit) as Row | undefined
      if (!row) return undefined
      const token = randomUUID()
      this.db
        .prepare(
          "UPDATE jobs SET state = 'running', attempts = attempts + 1, lease_token = ?, lease_until = ?, updated_at = ?, error = NULL WHERE id = ?",
        )
        .run(token, now + options.leaseMs, now, row.id)
      return this.get(row.id)
    })
  }
  renew(id: string, token: string, leaseMs: number, now = Date.now()): boolean {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('Invalid job lease')
    return (
      Number(
        this.db
          .prepare(
            "UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_until > ?",
          )
          .run(now + leaseMs, now, id, token, now).changes,
      ) === 1
    )
  }
  finish(
    id: string,
    token: string,
    state: 'completed' | 'failed',
    error: string | null = null,
    now = Date.now(),
  ): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE jobs SET state = ?, error = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_until > ?",
          )
          .run(state, error, now, id, token, now).changes,
      ) === 1
    )
  }
  retry(id: string, now = Date.now()): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE jobs SET state = 'queued', position = (SELECT COALESCE(MAX(position), 0) + 1 FROM jobs), error = NULL, updated_at = ? WHERE id = ? AND state IN ('interrupted', 'failed', 'cancelled')",
          )
          .run(now, id).changes,
      ) === 1
    )
  }
  cancel(id: string, now = Date.now()): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'queued'",
          )
          .run(now, id).changes,
      ) === 1
    )
  }
  move(id: string, direction: 'up' | 'down', now = Date.now()): boolean {
    return this.transaction(() => {
      const queued = this.list().filter((item) => item.state === 'queued')
      const index = queued.findIndex((item) => item.id === id)
      const other = queued[index + (direction === 'up' ? -1 : 1)]
      const current = queued[index]
      if (!current || !other) return false
      const update = this.db.prepare('UPDATE jobs SET position = ?, updated_at = ? WHERE id = ?')
      update.run(other.position, now, current.id)
      update.run(current.position, now, other.id)
      return true
    })
  }
}
