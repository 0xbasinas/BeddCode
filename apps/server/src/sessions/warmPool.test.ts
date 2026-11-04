import { describe, expect, it, vi } from 'vitest'
import { readProcessMemory } from '@beddcode/shared'
import { WarmPool, type WarmResource } from './warmPool.ts'

const options = { size: 1, idleTimeoutMs: 100, memoryCapBytes: 1000 }
const resource = (healthy = true, memory: number | null = 100) => ({
  healthy: vi.fn(async () => healthy),
  memoryBytes: vi.fn(async () => memory),
  close: vi.fn(async () => {}),
})
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('WarmPool', () => {
  it('hands a resource out only once and creates a replacement', async () => {
    const first = resource()
    const second = resource()
    const create = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second)
    const pool = new WarmPool(options, create)
    pool.refill('agent/project/config')
    pool.refill('agent/project/config')
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
    expect(await pool.take('agent/project/config')).toBe(first)
    await settle()
    expect(await pool.take('agent/project/config')).toBe(second)
    expect(first.close).not.toHaveBeenCalled()
    await pool.close()
  })

  it.each([
    ['dead', false, 100],
    ['over memory cap', true, 1001],
    ['unmeasurable', true, null],
  ])('discards a %s resource', async (_name, healthy, memory) => {
    const item = resource(healthy, memory)
    const pool = new WarmPool(options, async () => item)
    pool.refill('key')
    await settle()
    expect(await pool.take('key')).toBeNull()
    expect(item.close).toHaveBeenCalledTimes(1)
    await pool.close()
  })

  it('expires idle resources and isolates keys', async () => {
    let now = 0
    const item = resource()
    const pool = new WarmPool(
      options,
      async () => item,
      () => now,
    )
    pool.refill('one')
    await settle()
    expect(await pool.take('two')).toBeNull()
    now = 100
    expect(await pool.take('one')).toBeNull()
    expect(item.close).toHaveBeenCalled()
    await pool.close()
  })

  it('disposes a creation that completes after reconfiguration or shutdown', async () => {
    let finish!: (value: WarmResource) => void
    const item = resource()
    const pool = new WarmPool(
      options,
      () =>
        new Promise<WarmResource>((resolve) => {
          finish = resolve
        }),
    )
    pool.refill('key')
    await pool.configure(options)
    finish(item)
    await settle()
    expect(item.close).toHaveBeenCalledTimes(1)
    expect(await pool.take('key')).toBeNull()
    await pool.close()
  })

  it('enforces one total memory budget across keys and reinspects growth', async () => {
    const first = resource(true, 600)
    const second = resource(true, 600)
    const pool = new WarmPool(options, async (key) => (key === 'a' ? first : second))
    pool.refill('a')
    await settle()
    pool.refill('b')
    await settle()
    expect(second.close).toHaveBeenCalledTimes(1)
    first.memoryBytes.mockResolvedValue(1001)
    await pool.maintain()
    expect(first.close).toHaveBeenCalledTimes(1)
    await pool.close()
  })

  it('enforces the cap with values measured from /proc', async () => {
    const status = (kb: number) => `VmRSS:\t${kb} kB\n`
    const rss: Record<number, number> = { 1: 600, 2: 600 }
    const measured = (pid: number) => ({
      ...resource(),
      memoryBytes: vi.fn(() =>
        readProcessMemory(pid, {
          platform: 'linux',
          readFile: async (path) => {
            if (path === `/proc/${pid}/status`) return status(rss[pid]!)
            throw new Error('ENOENT')
          },
          readdir: async () => [],
        }),
      ),
    })
    const first = measured(1)
    const second = measured(2)
    const pool = new WarmPool(
      { ...options, memoryCapBytes: 1000 * 1024 },
      async (key) => (key === 'a' ? first : second),
    )
    pool.refill('a')
    await settle()
    pool.refill('b')
    await settle()
    expect(second.close).toHaveBeenCalledTimes(1)
    expect(first.close).not.toHaveBeenCalled()
    rss[1] = 1001
    await pool.maintain()
    expect(first.close).toHaveBeenCalledTimes(1)
    await pool.close()
  })

  it('does not give the same resource to concurrent checkouts', async () => {
    const first = resource()
    const pool = new WarmPool(options, async () => first)
    pool.refill('key')
    await settle()
    const results = await Promise.all([pool.take('key'), pool.take('key')])
    expect(results.filter((value) => value === first)).toHaveLength(1)
    await pool.close()
  })

  it('expires and closes idle resources during maintenance without a checkout', async () => {
    let now = 0
    const first = resource()
    const pool = new WarmPool(
      options,
      async () => first,
      () => now,
    )
    pool.refill('key')
    await settle()
    now = 100
    await pool.maintain()
    expect(first.close).toHaveBeenCalledTimes(1)
    await pool.close()
  })

  it('backs off failed starts and retries on maintenance', async () => {
    let now = 0
    const first = resource()
    const create = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(first)
    const pool = new WarmPool(options, create, () => now)
    pool.refill('key')
    await settle()
    await pool.maintain()
    expect(create).toHaveBeenCalledTimes(1)
    now = 1000
    await pool.maintain()
    await settle()
    expect(create).toHaveBeenCalledTimes(2)
    expect(await pool.take('key')).toBe(first)
    await pool.close()
  })

  it('discards old creations when a removed key is registered again', async () => {
    let finish!: (item: WarmResource) => void
    const old = resource()
    const fresh = resource()
    const create = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<WarmResource>((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValue(fresh)
    const pool = new WarmPool(options, create)
    pool.refill('key')
    await pool.remove('key')
    pool.refill('key')
    finish(old)
    await settle()
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(await pool.take('key')).toBe(fresh)
    await pool.close()
  })

  it('does not hand out a resource when shutdown races inspection', async () => {
    let finish!: (bytes: number) => void
    const item = resource()
    const pool = new WarmPool(options, async () => item)
    pool.refill('key')
    await settle()
    item.memoryBytes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const taking = pool.take('key')
    await settle()
    const closing = pool.close()
    finish(100)
    expect(await taking).toBeNull()
    await closing
    expect(item.close).toHaveBeenCalledTimes(1)
  })

  it('does not hand out an old resource when reconfiguration races inspection', async () => {
    let finish!: (bytes: number) => void
    const item = resource()
    const pool = new WarmPool(options, async () => item)
    pool.refill('key')
    await settle()
    item.memoryBytes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const taking = pool.take('key')
    await settle()
    const configuring = pool.configure(options)
    finish(100)
    expect(await taking).toBeNull()
    await configuring
    expect(item.close).toHaveBeenCalledTimes(1)
    await pool.close()
  })

  it('does not let an old creation suppress or decrement a new generation', async () => {
    const finishes: ((item: WarmResource) => void)[] = []
    const create = vi.fn(() => new Promise<WarmResource>((resolve) => finishes.push(resolve)))
    const pool = new WarmPool(options, create)
    pool.refill('key')
    await pool.configure(options)
    pool.refill('key')
    const old = resource()
    finishes[0]!(old)
    await settle()
    pool.refill('key')
    expect(create).toHaveBeenCalledTimes(2)
    const fresh = resource()
    finishes[1]!(fresh)
    await settle()
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(await pool.take('key')).toBe(fresh)
    await pool.close()
  })
})
