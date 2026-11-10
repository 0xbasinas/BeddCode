import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

/** Created only while holding the host lock. An unfinished run counts as a crash. */
export function trackHostState(home: string) {
  const file = path.join(home, 'host-state.json')
  let previous: { crashCount?: number; running?: boolean } = {}
  try {
    previous = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    /* first run */
  }
  const crashCount =
    (Number.isSafeInteger(previous?.crashCount) && previous.crashCount! >= 0
      ? previous.crashCount!
      : 0) + (previous?.running === true ? 1 : 0)
  const state = { crashCount, running: true, startedAt: Date.now(), pid: process.pid }
  const save = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(state))
    renameSync(`${file}.tmp`, file)
  }
  save()
  return {
    get crashCount() {
      return state.crashCount
    },
    finish(failed: boolean) {
      if (!state.running) return
      state.running = false
      if (failed) state.crashCount++
      save()
    },
  }
}

export function monitorHostLoop() {
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  let lag = { meanMs: 0, maxMs: 0, p99Ms: 0 }
  const timer = setInterval(() => {
    lag = {
      meanMs: Number.isFinite(histogram.mean) ? histogram.mean / 1e6 : 0,
      maxMs: histogram.max / 1e6,
      p99Ms: histogram.percentile(99) / 1e6,
    }
    histogram.reset()
  }, 5_000)
  timer.unref()
  return {
    snapshot: () => lag,
    stop() {
      clearInterval(timer)
      histogram.disable()
    },
  }
}
