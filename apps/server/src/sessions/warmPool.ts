/** An unused resource belongs to the pool until it is checked out or disposed. */
export interface WarmResource {
  healthy(): Promise<boolean>
  /** Resident bytes for the entire process tree, or null if it cannot be measured. */
  memoryBytes(): Promise<number | null>
  close(): Promise<void>
}

export interface WarmPoolOptions {
  size: number
  idleTimeoutMs: number
  /** Total resident bytes allowed across all idle resources. */
  memoryCapBytes: number
  /** How often to inspect idle resources and retry failed starts. */
  maintenanceIntervalMs?: number
}

interface Entry<T> {
  resource: T
  createdAt: number
}

/** Owns unused resources only. A successful checkout transfers ownership permanently. */
export class WarmPool<T extends WarmResource> {
  private readonly entries = new Map<string, Entry<T>[]>()
  private readonly pending = new Map<string, number>()
  private readonly keys = new Set<string>()
  private readonly failures = new Map<string, { count: number; retryAt: number }>()
  private readonly keyEpoch = new Map<string, number>()
  private generation = 0
  private closed = false
  private serial: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private options: WarmPoolOptions,
    private readonly create: (key: string) => Promise<T>,
    private readonly now: () => number = Date.now,
  ) {
    this.startTimer()
  }

  private startTimer(): void {
    if (this.timer) clearInterval(this.timer)
    const interval = this.options.maintenanceIntervalMs ?? 30_000
    if (!Number.isFinite(interval) || interval <= 0 || this.closed) return
    this.timer = setInterval(() => void this.maintain(), interval)
    this.timer.unref?.()
  }

  /** Serialize inspection, insertion, and checkout so concurrent checkouts cannot exceed the cap. */
  private locked<R>(fn: () => Promise<R>): Promise<R> {
    const result = this.serial.then(fn)
    this.serial = result.then(
      () => {},
      () => {},
    )
    return result
  }

  private async dispose(resource: T): Promise<void> {
    await resource.close().catch(() => {})
  }

  private async inspect(entry: Entry<T>): Promise<number | null> {
    try {
      if (
        !Number.isFinite(this.options.idleTimeoutMs) ||
        this.options.idleTimeoutMs <= 0 ||
        this.now() - entry.createdAt >= this.options.idleTimeoutMs
      )
        return null
      const bytes = await entry.resource.memoryBytes()
      if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null
      return (await entry.resource.healthy()) ? bytes : null
    } catch {
      return null
    }
  }

  /** Prune dead, expired, unmeasurable and over-budget resources across all keys. */
  private async prune(): Promise<void> {
    let total = 0
    for (const [key, entries] of this.entries) {
      const kept: Entry<T>[] = []
      for (const entry of entries) {
        const bytes = await this.inspect(entry)
        if (
          bytes === null ||
          !Number.isFinite(this.options.memoryCapBytes) ||
          total + bytes > this.options.memoryCapBytes
        ) {
          await this.dispose(entry.resource)
        } else {
          total += bytes
          kept.push(entry)
        }
      }
      if (kept.length) this.entries.set(key, kept)
      else this.entries.delete(key)
    }
  }

  /** In-flight creations from the previous configuration are discarded when they finish. */
  async configure(options: WarmPoolOptions): Promise<void> {
    this.options = options
    this.startTimer()
    await this.clear()
  }

  /** Starts replacements in the background. Failed starts use bounded exponential backoff. */
  refill(key: string): void {
    if (this.closed) return
    this.keys.add(key)
    if ((this.failures.get(key)?.retryAt ?? 0) > this.now()) return
    const count = this.entries.get(key)?.length ?? 0
    const pending = this.pending.get(key) ?? 0
    const size = Number.isFinite(this.options.size) ? Math.max(0, Math.floor(this.options.size)) : 0
    const generation = this.generation
    const epoch = this.keyEpoch.get(key) ?? 0
    for (let i = count + pending; i < size; i++) {
      this.pending.set(key, (this.pending.get(key) ?? 0) + 1)
      let creation: Promise<T>
      try {
        creation = this.create(key)
      } catch (error) {
        creation = Promise.reject(error)
      }
      void creation
        .then((resource) =>
          this.locked(async () => {
            if (
              this.closed ||
              generation !== this.generation ||
              !this.keys.has(key) ||
              epoch !== (this.keyEpoch.get(key) ?? 0)
            ) {
              await this.dispose(resource)
              return
            }
            const entries = this.entries.get(key) ?? []
            entries.push({ resource, createdAt: this.now() })
            this.entries.set(key, entries)
            await this.prune()
            if (!this.entries.get(key)?.some((entry) => entry.resource === resource)) {
              this.failed(key)
            } else {
              this.failures.delete(key)
            }
          }),
        )
        .catch(() => {
          if (
            !this.closed &&
            generation === this.generation &&
            epoch === (this.keyEpoch.get(key) ?? 0)
          )
            this.failed(key)
        })
        .finally(() => {
          // Old completions must not decrement a new generation's pending count.
          if (generation !== this.generation || epoch !== (this.keyEpoch.get(key) ?? 0)) return
          const left = (this.pending.get(key) ?? 1) - 1
          if (left > 0) this.pending.set(key, left)
          else this.pending.delete(key)
        })
    }
  }

  private failed(key: string): void {
    const count = Math.min((this.failures.get(key)?.count ?? 0) + 1, 10)
    this.failures.set(key, {
      count,
      retryAt: this.now() + Math.min(60_000, 1000 * 2 ** (count - 1)),
    })
  }

  /** Returns a healthy resource once, or null so the caller can start cold. */
  async take(key: string): Promise<T | null> {
    const generation = this.generation
    const epoch = this.keyEpoch.get(key) ?? 0
    const result = await this.locked(async () => {
      if (this.closed || generation !== this.generation || epoch !== (this.keyEpoch.get(key) ?? 0))
        return null
      await this.prune()
      if (this.closed || generation !== this.generation || epoch !== (this.keyEpoch.get(key) ?? 0))
        return null
      const entries = this.entries.get(key)
      const entry = entries?.shift()
      if (!entries?.length) this.entries.delete(key)
      return entry?.resource ?? null
    })
    if (generation === this.generation && epoch === (this.keyEpoch.get(key) ?? 0)) this.refill(key)
    return result
  }

  /** Inspect idle resources and refill registered keys, including after a failed start. */
  async maintain(): Promise<void> {
    await this.locked(async () => {
      if (!this.closed) await this.prune()
    })
    for (const key of this.keys) this.refill(key)
  }

  /** Stop maintaining a removed project or agent and discard its idle resources. */
  async remove(key: string): Promise<void> {
    this.keys.delete(key)
    this.failures.delete(key)
    this.pending.delete(key)
    this.keyEpoch.set(key, (this.keyEpoch.get(key) ?? 0) + 1)
    await this.locked(async () => {
      const entries = this.entries.get(key) ?? []
      this.entries.delete(key)
      await Promise.all(entries.map(({ resource }) => this.dispose(resource)))
    })
  }

  /** Drops all idle resources; checked-out resources are owned by their sessions. */
  async clear(): Promise<void> {
    this.generation++
    this.pending.clear()
    this.keys.clear()
    this.failures.clear()
    this.keyEpoch.clear()
    await this.locked(async () => {
      const entries = [...this.entries.values()].flat()
      this.entries.clear()
      await Promise.all(entries.map(({ resource }) => this.dispose(resource)))
    })
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    await this.clear()
  }
}
