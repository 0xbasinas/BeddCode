/**
 * Slows down guessing. Failed password attempts and overall requests are counted per caller in a
 * sliding window; past the limit the caller is told to wait. Held in memory by one object, so the
 * count is shared by everyone reaching it.
 */
export interface LimiterOptions {
  /** Wrong passwords allowed per window before the caller is locked out. */
  maxFailures?: number
  /** Requests of any kind allowed per window. */
  maxRequests?: number
  windowMs?: number
  /** Callers remembered at most, so the table itself cannot be filled. */
  maxCallers?: number
}

interface Entry {
  failures: number[]
  requests: number[]
}

export class Limiter {
  private readonly callers = new Map<string, Entry>()
  private readonly maxFailures: number
  private readonly maxRequests: number
  private readonly windowMs: number
  private readonly maxCallers: number

  constructor(options: LimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5
    this.maxRequests = options.maxRequests ?? 120
    this.windowMs = options.windowMs ?? 10 * 60_000
    this.maxCallers = options.maxCallers ?? 5000
  }

  private entry(caller: string, now: number): Entry {
    let e = this.callers.get(caller)
    if (!e) {
      if (this.callers.size >= this.maxCallers)
        this.callers.delete(this.callers.keys().next().value!)
      e = { failures: [], requests: [] }
      this.callers.set(caller, e)
    }
    const since = now - this.windowMs
    e.failures = e.failures.filter((t) => t > since)
    e.requests = e.requests.filter((t) => t > since)
    return e
  }

  /** Seconds to wait before trying again, or 0 when the request may go ahead. Counts the request. */
  check(caller: string, now = Date.now()): number {
    const e = this.entry(caller, now)
    if (e.failures.length >= this.maxFailures) return this.wait(e.failures, now)
    if (e.requests.length >= this.maxRequests) return this.wait(e.requests, now)
    e.requests.push(now)
    return 0
  }

  fail(caller: string, now = Date.now()): void {
    this.entry(caller, now).failures.push(now)
  }

  /** A correct password clears the caller's failures. */
  succeed(caller: string, now = Date.now()): void {
    this.entry(caller, now).failures = []
  }

  private wait(times: number[], now: number): number {
    return Math.max(1, Math.ceil((times[0]! + this.windowMs - now) / 1000))
  }
}
