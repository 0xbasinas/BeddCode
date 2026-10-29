import { describe, expect, it } from 'vitest'
import { onDeviceWake } from './wake.ts'

describe('onDeviceWake', () => {
  it('fires when the network returns or the page becomes visible, not when it hides', () => {
    const win = new EventTarget()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    let wakes = 0
    const off = onDeviceWake(() => wakes++, win, doc)
    win.dispatchEvent(new Event('online'))
    expect(wakes).toBe(1)
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(wakes).toBe(1)
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('focus'))
    expect(wakes).toBe(3)
    off()
    win.dispatchEvent(new Event('online'))
    expect(wakes).toBe(3)
  })

  it('fires when timers come back far too late (the machine slept), only while visible', () => {
    let now = 0
    let tick = () => {}
    let stopped = false
    const clock = {
      now: () => now,
      every: (_ms: number, fn: () => void) => {
        tick = fn
        return () => (stopped = true)
      },
    }
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    let wakes = 0
    const off = onDeviceWake(() => wakes++, new EventTarget(), doc, clock)
    now += 5_000
    tick()
    now += 6_000
    tick()
    expect(wakes).toBe(0)
    now += 3_600_000
    tick()
    expect(wakes).toBe(1)
    // The clock set back by an hour.
    now -= 3_600_000
    tick()
    expect(wakes).toBe(2)
    doc.visibilityState = 'hidden'
    now += 60_000
    tick()
    expect(wakes).toBe(2)
    off()
    expect(stopped).toBe(true)
  })
})
