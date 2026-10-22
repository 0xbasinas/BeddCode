import { describe, expect, it } from 'vitest'
import { runWindowAction, type ControlledWindow } from './windowActions.ts'

function fakeWindow(maximized = false) {
  const calls: string[] = []
  const win: ControlledWindow = {
    minimize: () => void calls.push('minimize'),
    maximize: () => {
      calls.push('maximize')
      maximized = true
    },
    unmaximize: () => {
      calls.push('unmaximize')
      maximized = false
    },
    close: () => void calls.push('close'),
    isMaximized: () => maximized,
  }
  return { win, calls }
}

describe('runWindowAction', () => {
  it('maximizes and restores in turn, reporting the new state', () => {
    const { win, calls } = fakeWindow()
    expect(runWindowAction(win, 'toggleMaximize')).toBe(true)
    expect(runWindowAction(win, 'toggleMaximize')).toBe(false)
    expect(calls).toEqual(['maximize', 'unmaximize'])
  })

  it('minimizes and closes', () => {
    const { win, calls } = fakeWindow(true)
    expect(runWindowAction(win, 'minimize')).toBe(true)
    runWindowAction(win, 'close')
    expect(calls).toEqual(['minimize', 'close'])
  })

  it('reports the state without changing it', () => {
    const { win, calls } = fakeWindow(true)
    expect(runWindowAction(win, 'isMaximized')).toBe(true)
    expect(calls).toEqual([])
  })

  it('ignores anything that is not a known action', () => {
    const { win, calls } = fakeWindow()
    for (const action of ['setBounds', 'destroy', '', null, undefined, 42, { action: 'close' }])
      expect(runWindowAction(win, action)).toBeNull()
    expect(calls).toEqual([])
  })
})
