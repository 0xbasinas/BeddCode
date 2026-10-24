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
})
