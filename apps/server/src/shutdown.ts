import type { Logger } from '@beddcode/shared'

export interface ShutdownOptions {
  /** Closes everything, in order. */
  close(): Promise<void>
  exit(code: number): void
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** How long closing may take before the process exits anyway. */
  timeoutMs?: number
}

/**
 * Stops the host once, whatever asks first, saying why. Closing that hangs (an agent that will not
 * end, a socket that will not close) does not keep the process alive past the timeout, so whoever
 * restarts it is not left waiting on a port that is still taken.
 */
export function createShutdown(options: ShutdownOptions) {
  let started = false
  return (reason: string, code = 0) => {
    if (started) return
    started = true
    options.log.info(`stopping: ${reason}`)
    const timer = setTimeout(() => {
      options.log.warn('took too long to stop, exiting anyway')
      options.exit(code || 1)
    }, options.timeoutMs ?? 5_000)
    timer.unref?.()
    options.close().then(
      () => {
        clearTimeout(timer)
        options.exit(code)
      },
      (err: unknown) => {
        clearTimeout(timer)
        options.log.error(`could not stop cleanly: ${String(err)}`)
        options.exit(code || 1)
      },
    )
  }
}

export interface CrashWatchOptions {
  /**
   * How many uncaught exceptions to survive before stopping the host. Agent-driven work (a
   * terminal's output, a watcher's events) can throw in a handler; each one is logged and the
   * host keeps serving, but past this many inside `windowMs` the host stops cleanly instead of
   * running on in an unknown state — whoever supervises it (the app, systemd, the task) starts
   * it again fresh.
   */
  maxUncaught?: number
  windowMs?: number
}

/**
 * Logs failures nobody handled. A stray rejection is logged and survived. A thrown error is too,
 * until `maxUncaught` of them land inside `windowMs`: then the host stops cleanly (code 1) so it
 * is restarted rather than left half-broken.
 */
export function watchForCrashes(
  log: Pick<Logger, 'error'>,
  stop: (reason: string, code: number) => void,
  target: Pick<NodeJS.Process, 'on'> = process,
  options: CrashWatchOptions = {},
) {
  const maxUncaught = options.maxUncaught ?? 5
  const windowMs = options.windowMs ?? 60_000
  const seen: number[] = []
  let tripped = false
  target.on('unhandledRejection', (reason: unknown) => {
    log.error(`unhandled rejection: ${describe(reason)}`)
  })
  target.on('uncaughtException', (err: unknown) => {
    log.error(`uncaught exception: ${describe(err)}`)
    if (tripped) return
    const now = Date.now()
    while (seen.length > 0 && now - seen[0]! > windowMs) seen.shift()
    seen.push(now)
    if (seen.length >= maxUncaught) {
      tripped = true
      seen.length = 0
      stop(`${maxUncaught} uncaught exceptions in ${windowMs / 1000}s`, 1)
    }
  })
}

const describe = (value: unknown) =>
  value instanceof Error ? (value.stack ?? value.message) : String(value)
