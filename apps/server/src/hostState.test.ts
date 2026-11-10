import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { monitorHostLoop, trackHostState } from './hostState.ts'

it('persists crashes, counts abandoned runs, and does not count clean stops', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'host-state-'))
  try {
    const first = trackHostState(home)
    expect(first.crashCount).toBe(0)
    first.finish(false)
    const second = trackHostState(home)
    expect(second.crashCount).toBe(0)
    second.finish(true)
    second.finish(true)
    expect(trackHostState(home).crashCount).toBe(1)
    const recovered = trackHostState(home)
    expect(recovered.crashCount).toBe(2)
    recovered.finish(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('measures a blocked event loop and stops its sampling timer', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const monitor = monitorHostLoop()
  try {
    await delay(40)
    const end = process.hrtime.bigint() + 80_000_000n
    while (process.hrtime.bigint() < end) {
      /* simulate a synchronous handler */
    }
    await delay(40)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(monitor.snapshot().maxMs).toBeGreaterThan(50)
    expect(Number.isFinite(monitor.snapshot().meanMs)).toBe(true)
    monitor.stop()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    monitor.stop()
    vi.useRealTimers()
  }
})
