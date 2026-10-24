import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createShutdown, watchForCrashes } from './shutdown.ts'

const logger = () => {
  const lines: string[] = []
  return {
    lines,
    info: (m: string) => void lines.push(`info ${m}`),
    warn: (m: string) => void lines.push(`warn ${m}`),
    error: (m: string) => void lines.push(`error ${m}`),
  }
}

describe('createShutdown', () => {
  it('closes once and exits, saying why', async () => {
    const log = logger()
    const exit = vi.fn()
    const close = vi.fn(async () => {})
    const stop = createShutdown({ close, exit, log })
    stop('SIGTERM')
    stop('SIGINT')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(close).toHaveBeenCalledTimes(1)
    expect(log.lines).toEqual(['info stopping: SIGTERM'])
  })

  it('exits anyway when closing hangs', async () => {
    const log = logger()
    const exit = vi.fn()
    const stop = createShutdown({ close: () => new Promise(() => {}), exit, log, timeoutMs: 10 })
    stop('SIGTERM')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(log.lines).toContain('warn took too long to stop, exiting anyway')
  })

  it('exits with an error when closing fails', async () => {
    const log = logger()
    const exit = vi.fn()
    const stop = createShutdown({ close: async () => Promise.reject(new Error('busy')), exit, log })
    stop('SIGINT')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(log.lines.at(-1)).toContain('busy')
  })
})

describe('watchForCrashes', () => {
  it('logs a stray rejection and keeps going, but stops on a thrown error', () => {
    const log = logger()
    const stop = vi.fn()
    const target = new EventEmitter()
    watchForCrashes(log, stop, target as unknown as NodeJS.Process)
    target.emit('unhandledRejection', new Error('lost promise'))
    expect(stop).not.toHaveBeenCalled()
    expect(log.lines[0]).toContain('lost promise')
    target.emit('uncaughtException', new Error('boom'))
    expect(stop).toHaveBeenCalledWith('uncaught exception', 1)
  })
})
