import { afterEach, describe, expect, it, vi } from 'vitest'
import { appWindowControls, type DesktopWindow } from './desktop.ts'

const controls: DesktopWindow = {
  minimize: async () => false,
  toggleMaximize: async () => true,
  close: async () => false,
  isMaximized: async () => false,
  onMaximizedChange: () => () => {},
}

describe('appWindowControls', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is absent in the browser build', () => {
    vi.stubGlobal('window', {})
    expect(appWindowControls()).toBeUndefined()
  })

  it('is the bridge in the desktop app on Linux and Windows', () => {
    for (const platform of ['linux', 'win32']) {
      vi.stubGlobal('window', { beddcodeDesktop: { platform, window: controls } })
      expect(appWindowControls()).toBe(controls)
    }
  })

  it('is absent on macOS, which keeps its traffic lights', () => {
    vi.stubGlobal('window', { beddcodeDesktop: { platform: 'darwin', window: controls } })
    expect(appWindowControls()).toBeUndefined()
  })
})
