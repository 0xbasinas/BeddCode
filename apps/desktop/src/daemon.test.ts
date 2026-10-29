import { describe, expect, it } from 'vitest'
import { Daemon, backoff, type DaemonState, type HostProcess, type LaunchSpec } from './daemon.ts'

const launch: LaunchSpec = { command: 'node', args: ['host.js'] }

/** A host that is up while `up` is true; processes it "starts" are recorded and controlled here. */
function setup(options: { ignoresKill?: boolean } = {}) {
  const clock = { t: 0 }
  /** Ends the long wait after giving up, as the minute passing would. */
  const parked: (() => void)[] = []
  const world = {
    up: false,
    /** When set, a started process answers as soon as it exists. */
    answers: true,
    started: [] as {
      log: (line: string) => void
      end(code: number | null): void
      killed: boolean
      forced: boolean
    }[],
  }
  const daemon = new Daemon({
    launch,
    probe: async () => world.up,
    stopGraceMs: 10,
    sleep: (ms) => {
      if (ms >= 60_000) return new Promise<void>((resolve) => parked.push(resolve))
      clock.t += ms
      return Promise.resolve()
    },
    now: () => clock.t,
    spawnHost(_spec, log): HostProcess {
      let end!: (code: number | null) => void
      const exited = new Promise<number | null>((resolve) => (end = resolve))
      const proc = {
        log,
        killed: false,
        forced: false,
        end(code: number | null) {
          world.up = false
          end(code)
        },
      }
      world.started.push(proc)
      if (world.answers) world.up = true
      return {
        exited,
        kill: () => {
          proc.killed = true
          if (!options.ignoresKill) proc.end(null)
        },
        forceKill: () => {
          proc.forced = true
          proc.end(null)
        },
      }
    },
  })
  const seen: DaemonState[] = []
  daemon.onChange((s) => seen.push(s))
  /** Resolves when the daemon reaches a state satisfying `test`. */
  const until = (test: (s: DaemonState) => boolean) =>
    new Promise<DaemonState>((resolve) => {
      if (test(daemon.current)) return resolve(daemon.current)
      const off = daemon.onChange((s) => {
        if (test(s)) {
          off()
          resolve(s)
        }
      })
    })
  return { daemon, world, seen, clock, until, parked }
}

describe('backoff', () => {
  it('doubles from a second up to fifteen', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(backoff)).toEqual([
      1000, 2000, 4000, 8000, 15000, 15000, 15000,
    ])
  })
})

describe('Daemon', () => {
  it('uses a host that is already running and leaves it alone', async () => {
    const { daemon, world, until } = setup()
    world.up = true
    daemon.start()
    await until((s) => s.status === 'attached')
    expect(world.started).toHaveLength(0)
    await daemon.stop()
    expect(world.started).toHaveLength(0)
    expect(daemon.current.status).toBe('stopped')
  })

  it('starts the host when none runs, and stops it with the app', async () => {
    const { daemon, world, until, seen } = setup()
    daemon.start()
    await until((s) => s.status === 'running')
    expect(world.started).toHaveLength(1)
    expect(seen.map((s) => s.status)).toEqual(['starting', 'running'])
    await daemon.stop()
    expect(world.started[0]?.killed).toBe(true)
    expect(daemon.current.status).toBe('stopped')
  })

  it('starts it again when it stops, and counts the restarts', async () => {
    const { daemon, world, until } = setup()
    daemon.start()
    await until((s) => s.status === 'running')
    world.started[0]!.end(1)
    const again = await until((s) => s.status === 'running' && s.restarts === 1)
    expect(again.restarts).toBe(1)
    expect(world.started).toHaveLength(2)
    await daemon.stop()
  })

  it('gives up when it keeps stopping, saying what the host last said', async () => {
    const { daemon, world, until } = setup()
    world.answers = false
    // Every start ends at once.
    const original = world.started.push.bind(world.started)
    world.started.push = (...items) => {
      const n = original(...items)
      for (const item of items) {
        item.log('Error: port 3773 is already in use')
        queueMicrotask(() => item.end(1))
      }
      return n
    }
    daemon.start()
    const failed = await until((s) => s.status === 'failed')
    expect(failed.detail).toContain('port 3773 is already in use')
    // First try plus five more, then it waits.
    expect(world.started).toHaveLength(6)
    await daemon.stop()
    expect(daemon.current.status).toBe('stopped')
  })

  it('keeps trying once a minute after giving up, one start each time', async () => {
    const { daemon, world, until, parked } = setup()
    world.answers = false
    const original = world.started.push.bind(world.started)
    let failing = true
    world.started.push = (...items) => {
      const n = original(...items)
      for (const item of items) {
        if (failing) queueMicrotask(() => item.end(1))
        else world.up = true
      }
      return n
    }
    daemon.start()
    await until((s) => s.status === 'failed')
    expect(world.started).toHaveLength(6)
    // A minute on, still failing: one more try, then waiting again.
    await new Promise((r) => setTimeout(r, 0))
    parked.shift()!()
    await until((s) => s.status === 'restarting')
    await until((s) => s.status === 'failed')
    expect(world.started).toHaveLength(7)
    // Then whatever was in the way is gone.
    failing = false
    await new Promise((r) => setTimeout(r, 0))
    parked.shift()!()
    await until((s) => s.status === 'running')
    expect(world.started).toHaveLength(8)
    await daemon.stop()
  })

  it('kills a host outright when it does not stop when asked', async () => {
    const { daemon, world, until } = setup({ ignoresKill: true })
    daemon.start()
    await until((s) => s.status === 'running')
    await daemon.stop()
    expect(world.started[0]?.killed).toBe(true)
    expect(world.started[0]?.forced).toBe(true)
    expect(daemon.current.status).toBe('stopped')
  })

  it('forgets earlier crashes once the host has stayed up for a while', async () => {
    const { daemon, world, until, clock } = setup()
    daemon.start()
    await until((s) => s.status === 'running')
    for (let i = 0; i < 8; i++) {
      clock.t += 60_000 // it lived a minute: a one-off, not a crash loop
      world.started.at(-1)!.end(1)
      await until((s) => s.status === 'running' && world.started.length === i + 2)
    }
    expect(daemon.current.status).toBe('running')
    await daemon.stop()
  })

  it('takes over when a host it found goes away', async () => {
    const { daemon, world, until } = setup()
    world.up = true
    daemon.start()
    await until((s) => s.status === 'attached')
    world.up = false
    await until((s) => s.status === 'running')
    expect(world.started).toHaveLength(1)
    await daemon.stop()
  })

  it('replaces its own host on request, but not one it only found', async () => {
    const { daemon, world, until } = setup()
    daemon.start()
    await until((s) => s.status === 'running')
    expect(await daemon.restart()).toBe(true)
    await until((s) => world.started.length === 2 && s.status === 'running')
    expect(world.started[0]?.killed).toBe(true)
    // Asked for, so not counted as a failure.
    expect(daemon.current.restarts).toBe(0)
    await daemon.stop()

    const other = setup()
    other.world.up = true
    other.daemon.start()
    await other.until((s) => s.status === 'attached')
    expect(await other.daemon.restart()).toBe(false)
    await other.daemon.stop()
  })

  it('tries again from scratch after it gave up', async () => {
    const { daemon, world, until } = setup()
    world.answers = false
    const original = world.started.push.bind(world.started)
    let failing = true
    world.started.push = (...items) => {
      const n = original(...items)
      for (const item of items) {
        if (failing) queueMicrotask(() => item.end(1))
        else world.up = true
      }
      return n
    }
    daemon.start()
    await until((s) => s.status === 'failed')
    failing = false
    expect(await daemon.restart()).toBe(true)
    await until((s) => s.status === 'running')
    expect(daemon.current.restarts).toBe(0)
    await daemon.stop()
  })
})

describe('Daemon that does not start a host of its own', () => {
  function setupExternal(withService: boolean) {
    const clock = { t: 0 }
    const world = { up: false, spawned: 0, serviceStarts: 0 }
    let ticks = 0
    const daemon = new Daemon({
      launch,
      spawn: false,
      waitingDetail: 'Start one with beddcode serve',
      probe: async () => world.up,
      sleep: async (ms) => {
        clock.t += ms
        // Let the test look around between polls.
        if (++ticks % 5 === 0) await new Promise((r) => setTimeout(r, 0))
      },
      now: () => clock.t,
      spawnHost() {
        world.spawned++
        return { exited: new Promise<number | null>(() => undefined), kill() {} }
      },
      ...(withService && {
        startService: async () => {
          world.serviceStarts++
        },
      }),
    })
    const until = (test: (s: DaemonState) => boolean) =>
      new Promise<DaemonState>((resolve) => {
        if (test(daemon.current)) return resolve(daemon.current)
        const off = daemon.onChange((s) => {
          if (test(s)) {
            off()
            resolve(s)
          }
        })
      })
    return { daemon, world, clock, until }
  }

  it('waits, never starts one, and uses a host once it answers', async () => {
    const { daemon, world, until } = setupExternal(false)
    daemon.start()
    const waiting = await until((s) => s.status === 'waiting')
    expect(waiting.detail).toBe('Start one with beddcode serve')
    world.up = true
    await until((s) => s.status === 'attached')
    expect(world.spawned).toBe(0)
    // Gone again: back to waiting, still without starting one.
    world.up = false
    await until((s) => s.status === 'waiting')
    expect(world.spawned).toBe(0)
    expect(await daemon.restart()).toBe(false)
    await daemon.stop()
  })

  it('starts the background host, again every half minute, and at once when asked', async () => {
    const { daemon, world, clock, until } = setupExternal(true)
    daemon.start()
    await until((s) => s.status === 'waiting')
    await new Promise((r) => setTimeout(r, 5))
    expect(world.serviceStarts).toBeGreaterThanOrEqual(1)
    const before = world.serviceStarts
    const at = clock.t
    // Roughly one start per 30 s of polling.
    while (clock.t - at < 31_000) await new Promise((r) => setTimeout(r, 0))
    expect(world.serviceStarts).toBeGreaterThan(before)
    expect(await daemon.restart()).toBe(true)
    world.up = true
    await until((s) => s.status === 'attached')
    expect(world.spawned).toBe(0)
    await daemon.stop()
  })
})
