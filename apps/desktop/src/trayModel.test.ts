import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readDesktopSettings, writeDesktopSettings } from './desktopSettings.ts'
import {
  canStartAtLogin,
  defaultKeepRunning,
  shouldHideOnClose,
  statusLabel,
  trayMenu,
  type TrayActions,
} from './trayModel.ts'

describe('shouldHideOnClose', () => {
  const base = { keepRunning: true, quitting: false, platform: 'win32' as const }
  it('hides when asked to keep running', () => {
    expect(shouldHideOnClose(base)).toBe(true)
    expect(shouldHideOnClose({ ...base, platform: 'linux' })).toBe(true)
  })
  it('lets the window close when the setting is off or the app is quitting', () => {
    expect(shouldHideOnClose({ ...base, keepRunning: false })).toBe(false)
    expect(shouldHideOnClose({ ...base, quitting: true })).toBe(false)
  })
  it('leaves macOS alone, which keeps running by itself', () => {
    expect(shouldHideOnClose({ ...base, platform: 'darwin' })).toBe(false)
  })
})

describe('defaults', () => {
  it('turns tray behaviour on for Windows only', () => {
    expect(defaultKeepRunning('win32')).toBe(true)
    expect(defaultKeepRunning('linux')).toBe(false)
  })
  it('offers start-at-login only where it works, and only when installed', () => {
    expect(canStartAtLogin('win32', true)).toBe(true)
    expect(canStartAtLogin('win32', false)).toBe(false)
    expect(canStartAtLogin('linux', true)).toBe(false)
  })
})

describe('trayMenu', () => {
  const calls: string[] = []
  const actions: TrayActions = {
    open: () => void calls.push('open'),
    toggleKeepRunning: () => void calls.push('keep'),
    toggleStartAtLogin: () => void calls.push('login'),
    quit: () => void calls.push('quit'),
  }
  const model = {
    status: { status: 'running' as const, restarts: 0 },
    keepRunning: true,
    startAtLogin: false,
    canStartAtLogin: true,
  }

  it('lists open, status, the two toggles and quit', () => {
    const labels = trayMenu(model, actions).flatMap((i) => (i.label ? [i.label] : []))
    expect(labels).toEqual([
      'Open BeddCode',
      'Host running',
      'Keep running when the window is closed',
      'Start when I sign in',
      'Quit BeddCode',
    ])
  })

  it('leaves out start-at-login where it is not available', () => {
    const labels = trayMenu({ ...model, canStartAtLogin: false }, actions).map((i) => i.label)
    expect(labels).not.toContain('Start when I sign in')
  })

  it('wires each item to its action', () => {
    for (const item of trayMenu(model, actions)) item.click?.()
    expect(calls).toEqual(['open', 'keep', 'login', 'quit'])
  })

  it('shows the host state', () => {
    expect(statusLabel(null)).toBe('Host stopped')
    expect(statusLabel({ status: 'failed', restarts: 3 })).toBe('Host could not start')
    expect(statusLabel({ status: 'restarting', restarts: 1 })).toBe('Host starting…')
  })
})

describe('desktop settings', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('round-trips and ignores junk', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'bc-desktop-'))
    const file = path.join(dir, 'sub', 'desktop-settings.json')
    expect(readDesktopSettings(file)).toEqual({})
    writeDesktopSettings(file, { keepRunning: false, trayHintShown: true })
    expect(readDesktopSettings(file)).toEqual({ keepRunning: false, trayHintShown: true })
    writeFileSync(file, '{"keepRunning":"yes","other":1}')
    expect(readDesktopSettings(file)).toEqual({})
    writeFileSync(file, 'not json')
    expect(readDesktopSettings(file)).toEqual({})
  })
})
