import type { ReplicaState } from './replica.ts'

/**
 * Bump when `SessionView` or `applyEvent` change in a way that makes an old saved copy wrong:
 * it is then thrown away and the history is fetched again.
 */
export const SNAPSHOT_VERSION = 1

/** A copy of the history is not worth keeping past this size; the host is asked for it instead. */
export const MAX_SNAPSHOT_CHARS = 32_000_000

/** A saved copy of one host's history: what the replica was, and where in which log. */
export interface ReplicaSnapshot {
  v: number
  /** The host's `logId` when saved. */
  logId: string
  /** Resume after this seq. */
  seq: number
  replica: ReplicaState
}

// Session views are immutable. Serialize unchanged sessions once, rather than all history per save.
const encodedSessions = new WeakMap<object, string>()
export function encodeSnapshot(snapshot: ReplicaSnapshot): string | null {
  const { lastSeq, order, sessions } = snapshot.replica
  const head = `{"v":${snapshot.v},"logId":${JSON.stringify(snapshot.logId)},"seq":${snapshot.seq},"replica":{"lastSeq":${lastSeq},"order":${JSON.stringify(order)},"sessions":{`
  let length = head.length + 3
  if (length > MAX_SNAPSHOT_CHARS) return null
  const parts: string[] = []
  for (const [id, session] of Object.entries(sessions)) {
    let raw =
      typeof session === 'object' && session !== null ? encodedSessions.get(session) : undefined
    if (raw === undefined) {
      raw = JSON.stringify(session)
      if (typeof session === 'object' && session !== null && raw.length <= MAX_SNAPSHOT_CHARS)
        encodedSessions.set(session, raw)
    }
    const key = JSON.stringify(id)
    length += key.length + 1 + raw.length + (parts.length ? 1 : 0)
    if (length > MAX_SNAPSHOT_CHARS) return null
    parts.push(`${key}:${raw}`)
  }
  return `${head}${parts.join(',')}}}}`
}

/** The saved copy, or null when there is none or it cannot be trusted. */
export function decodeSnapshot(raw: string | null | undefined): ReplicaSnapshot | null {
  if (!raw || raw.length > MAX_SNAPSHOT_CHARS) return null
  try {
    const s = JSON.parse(raw) as Partial<ReplicaSnapshot>
    const r = s.replica
    if (
      s.v !== SNAPSHOT_VERSION ||
      typeof s.logId !== 'string' ||
      typeof s.seq !== 'number' ||
      !r ||
      typeof r.lastSeq !== 'number' ||
      !Array.isArray(r.order) ||
      typeof r.sessions !== 'object' ||
      r.sessions === null ||
      s.seq < r.lastSeq
    )
      return null
    return s as ReplicaSnapshot
  } catch {
    return null
  }
}

export interface ReplicaSaverOptions {
  /** Writes the saved copy, or removes it when given null. Failures are ignored. */
  write(raw: string | null): Promise<void>
  /** What to save now, or null to save nothing (e.g. an older host that has no `logId`). */
  snapshot(): ReplicaSnapshot | null
  /** Quiet time before saving. Default 4 s. */
  delayMs?: number
  /** A busy stream still saves at least this often. Default 30 s. */
  maxWaitMs?: number
}

/**
 * Saves the history shortly after it stops changing, so streaming text does not write to disk on
 * every word, and at least every `maxWaitMs` while it keeps changing.
 */
export class ReplicaSaver {
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirtySince = 0
  private writing: Promise<void> | null = null
  private pending: ReplicaSnapshot | null | undefined

  constructor(private readonly options: ReplicaSaverOptions) {}

  /** Something changed since the last save. */
  get dirty(): boolean {
    return this.dirtySince > 0
  }

  /** Call after the replica changed. */
  touch(now = Date.now()) {
    if (!this.dirtySince) this.dirtySince = now
    if (this.timer) clearTimeout(this.timer)
    const wait = Math.max(
      0,
      Math.min(
        this.options.delayMs ?? 4_000,
        this.dirtySince + (this.options.maxWaitMs ?? 30_000) - now,
      ),
    )
    this.timer = setTimeout(() => void this.flush(), wait)
  }

  /** Saves now (e.g. when the app goes to the background). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dirtySince = 0
    this.pending = this.options.snapshot()
    if (!this.writing) this.writing = this.drain()
    return this.writing
  }

  private async drain(): Promise<void> {
    // Defer serialization so repeated flushes in this turn retain only the latest snapshot.
    await Promise.resolve()
    try {
      while (this.pending !== undefined) {
        const snapshot = this.pending
        this.pending = undefined
        const raw = snapshot ? encodeSnapshot(snapshot) : null
        await this.options.write(raw).catch(() => {})
      }
    } finally {
      this.writing = null
    }
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dirtySince = 0
    this.pending = undefined
  }
}
