import { describe, expect, it } from 'vitest'
import {
  UPDATE_CHECK_INTERVAL_MS,
  shouldAutoUpdate,
  startAutoUpdate,
  type UpdaterLike,
} from './updater.ts'

describe('shouldAutoUpdate', () => {
  it('updates installed Windows builds and Linux AppImages only', () => {
    expect(shouldAutoUpdate({ packaged: true, platform: 'win32', env: {} })).toBe(true)
    expect(
      shouldAutoUpdate({ packaged: true, platform: 'linux', env: { APPIMAGE: '/x.AppImage' } }),
    ).toBe(true)
    // A .deb belongs to the package manager.
    expect(shouldAutoUpdate({ packaged: true, platform: 'linux', env: {} })).toBe(false)
    expect(shouldAutoUpdate({ packaged: true, platform: 'darwin', env: {} })).toBe(false)
  })

  it('never updates a build run from source, and can be turned off', () => {
    expect(shouldAutoUpdate({ packaged: false, platform: 'win32', env: {} })).toBe(false)
    expect(
      shouldAutoUpdate({ packaged: true, platform: 'win32', env: { BEDDCODE_NO_UPDATE: '1' } }),
    ).toBe(false)
  })
})

describe('startAutoUpdate', () => {
  function fake(check: () => Promise<unknown> = async () => undefined) {
    const calls = { checks: 0, errors: [] as ((err: Error) => void)[] }
    const updater: UpdaterLike = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdatesAndNotify: () => {
        calls.checks++
        return check()
      },
      on: (_event, listener) => void calls.errors.push(listener),
    }
    return { updater, calls }
  }

  it('checks at once, then on a schedule, downloading in the background', () => {
    const { updater, calls } = fake()
    let interval = 0
    let run: () => void = () => {}
    const stop = startAutoUpdate(updater, () => {}, ((fn: () => void, ms: number) => {
      run = fn
      interval = ms
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval)
    expect(calls.checks).toBe(1)
    expect(interval).toBe(UPDATE_CHECK_INTERVAL_MS)
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    run()
    expect(calls.checks).toBe(2)
    stop()
  })

  it('only logs a failed check', async () => {
    const messages: string[] = []
    const { updater, calls } = fake(async () => {
      throw new Error('offline')
    })
    const stop = startAutoUpdate(
      updater,
      (m) => messages.push(m),
      (() => 1) as unknown as typeof setInterval,
    )
    await Promise.resolve()
    await Promise.resolve()
    calls.errors[0]?.(new Error('no release'))
    expect(messages).toEqual(['update check failed: offline', 'update check failed: no release'])
    stop()
  })
})
