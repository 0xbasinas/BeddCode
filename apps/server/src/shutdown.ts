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

/** Logs failures nobody handled. A stray rejection is logged and survived; a thrown error stops the host. */
export function watchForCrashes(
  log: Pick<Logger, 'error'>,
  stop: (reason: string, code: number) => void,
  target: Pick<NodeJS.Process, 'on'> = process,
) {
  target.on('unhandledRejection', (reason: unknown) => {
    log.error(`unhandled rejection: ${describe(reason)}`)
  })
  target.on('uncaughtException', (err: unknown) => {
    log.error(`uncaught exception: ${describe(err)}`)
    stop('uncaught exception', 1)
  })
}

const describe = (value: unknown) =>
  value instanceof Error ? (value.stack ?? value.message) : String(value)
