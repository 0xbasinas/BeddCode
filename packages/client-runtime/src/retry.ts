export interface RetryOptions {
  /** Waits between attempts; the last one repeats. */
  delaysMs?: number[]
  /** False once the result no longer matters (the connection it was for is gone). */
  isCurrent?(): boolean
  /** Called after each failed attempt, e.g. to show that something is wrong. */
  onError?(error: Error, attempt: number): void
  sleep?(ms: number): Promise<void>
}

const DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

/**
 * Runs `load` until it succeeds or stops mattering. A host that is still starting its agents, or a
 * request lost in a reconnect, should not leave the app with an empty list until it is restarted.
 * Resolves with the result, or undefined when it gave up because it was no longer current.
 */
export async function retryWhileCurrent<T>(
  load: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T | undefined> {
  const delays = options.delaysMs ?? DELAYS_MS
  const isCurrent = options.isCurrent ?? (() => true)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 0; ; attempt++) {
    if (!isCurrent()) return undefined
    try {
      return await load()
    } catch (err) {
      if (!isCurrent()) return undefined
      options.onError?.(err instanceof Error ? err : new Error(String(err)), attempt)
    }
    await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 1_000)
  }
}
