import { describe, expect, it } from 'vitest'
import { Daemon, backoff, type DaemonState, type HostProcess, type LaunchSpec } from './daemon.ts'

const launch: LaunchSpec = { command: 'node', args: ['host.js'] }

/** A host that is up while `up` is true; processes it "starts" are recorded and controlled here. */
function setup() {
  const clock = { t: 0 }
  const world = {
    up: false,
    /** When set, a started process answers as soon as it exists. */
    answers: true,
    started: [] as {
      log: (line: string) => void
      end(code: number | null): void
      killed: boolean
    }[],
  }
  const daemon = new Daemon({
    launch,
    probe: async () => world.up,
    sleep: async (ms) => void (clock.t += ms),
    now: () => clock.t,
    spawnHost(_spec, log): HostProcess {
      let end!: (code: number | null) => void
      const exited = new Promise<number | null>((resolve) => (end = resolve))
      const proc = {
        log,
        killed: false,
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
  return { daemon, world, seen, clock, until }
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
    // First try plus five more, then it stops trying.
    expect(world.started).toHaveLength(6)
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
