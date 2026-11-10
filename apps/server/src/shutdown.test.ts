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
  it('logs a stray rejection and keeps going', () => {
    const log = logger()
    const stop = vi.fn()
    const target = new EventEmitter()
    watchForCrashes(log, stop, target as unknown as NodeJS.Process)
    target.emit('unhandledRejection', new Error('lost promise'))
    expect(stop).not.toHaveBeenCalled()
    expect(log.lines[0]).toContain('lost promise')
  })

  it('survives a few thrown errors, then stops cleanly so the host is restarted', () => {
    const log = logger()
    const stop = vi.fn()
    const target = new EventEmitter()
    watchForCrashes(log, stop, target as unknown as NodeJS.Process, {
      maxUncaught: 3,
      windowMs: 60_000,
    })
    target.emit('uncaughtException', new Error('boom 1'))
    target.emit('uncaughtException', new Error('boom 2'))
    expect(stop).not.toHaveBeenCalled()
    target.emit('uncaughtException', new Error('boom 3'))
    expect(stop).toHaveBeenCalledWith('3 uncaught exceptions in 60s', 1)
    for (let i = 0; i < 10; i++) target.emit('uncaughtException', new Error('during shutdown'))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('forgets thrown errors that fall outside the window', () => {
    const log = logger()
    const stop = vi.fn()
    const target = new EventEmitter()
    watchForCrashes(log, stop, target as unknown as NodeJS.Process, {
      maxUncaught: 2,
      windowMs: 1_000,
    })
    target.emit('uncaughtException', new Error('boom 1'))
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 5_000)
      target.emit('uncaughtException', new Error('boom 2'))
      expect(stop).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
