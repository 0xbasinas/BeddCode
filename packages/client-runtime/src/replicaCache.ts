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

export function encodeSnapshot(snapshot: ReplicaSnapshot): string | null {
  const raw = JSON.stringify(snapshot)
  return raw.length > MAX_SNAPSHOT_CHARS ? null : raw
}

/** The saved copy, or null when there is none or it cannot be trusted. */
export function decodeSnapshot(raw: string | null | undefined): ReplicaSnapshot | null {
  if (!raw) return null
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
  private writing: Promise<void> = Promise.resolve()

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
    const snapshot = this.options.snapshot()
    const raw = snapshot ? encodeSnapshot(snapshot) : null
    this.writing = this.writing.then(() => this.options.write(raw).catch(() => {}))
    return this.writing
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dirtySince = 0
  }
}
