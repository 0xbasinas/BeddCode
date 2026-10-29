import { describe, expect, it } from 'vitest'
import {
  backgroundHostInstalled,
  planHost,
  resolveHostMode,
  serviceCommands,
  startBackgroundHost,
  waitingDetail,
} from './hostMode.ts'

describe('resolveHostMode', () => {
  it('takes the environment, then BEDDCODE_NO_DAEMON, then the setting, then auto', () => {
    expect(resolveHostMode('app', { BEDDCODE_HOST_MODE: 'external' })).toBe('external')
    expect(resolveHostMode('app', { BEDDCODE_HOST_MODE: 'nonsense' })).toBe('app')
    expect(resolveHostMode('app', { BEDDCODE_NO_DAEMON: '1' })).toBe('external')
    expect(resolveHostMode('external', {})).toBe('external')
    expect(resolveHostMode(undefined, {})).toBe('auto')
  })
})

describe('planHost', () => {
  it('uses the background host instead of a second one when it is installed', () => {
    expect(planHost('auto', true)).toEqual({ spawn: false, useService: true })
    expect(planHost('auto', false)).toEqual({ spawn: true, useService: false })
  })
  it('starts its own only in app mode, and never in external mode', () => {
    expect(planHost('app', true)).toEqual({ spawn: true, useService: false })
    expect(planHost('external', false)).toEqual({ spawn: false, useService: false })
    expect(planHost('external', true)).toEqual({ spawn: false, useService: true })
  })
  it('says how to get a host while waiting', () => {
    expect(waitingDetail({ spawn: false, useService: true }, 3773, 'win32')).toContain(
      '"BeddCode Server" scheduled task',
    )
    expect(waitingDetail({ spawn: false, useService: false }, 3874, 'linux')).toContain('port 3874')
  })
})

describe('background host commands', () => {
  it('asks Task Scheduler on Windows and systemd on Linux', async () => {
    const calls: string[] = []
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args].join(' '))
      return file === 'schtasks' ? 0 : 1
    }
    expect(await backgroundHostInstalled('win32', run)).toBe(true)
    expect(await backgroundHostInstalled('linux', run)).toBe(false)
    expect(await backgroundHostInstalled('darwin', run)).toBe(false)
    await startBackgroundHost('win32', run)
    expect(calls).toEqual([
      'schtasks /Query /TN BeddCode Server',
      'systemctl --user is-enabled beddcode-server.service',
      'schtasks /Run /TN BeddCode Server',
    ])
    expect(serviceCommands('darwin')).toBeNull()
  })
})

describe('backgroundHostPort', () => {
  it('reads the port from the unit or the UTF-16 task definition', async () => {
    const { backgroundHostPort, servicePortOf } = await import('./hostMode.ts')
    expect(servicePortOf('ExecStart=/x/node /x/main.mjs serve --host 0.0.0.0')).toBe(3773)
    expect(servicePortOf('ExecStart=/x/node /x/main.mjs serve --port 3874')).toBe(3874)
    expect(servicePortOf('main.mjs serve --port=4000')).toBe(4000)
    const xml = Buffer.from(
      '\ufeff<Arguments>--headless x serve --port 3874</Arguments>',
      'utf16le',
    )
    expect(backgroundHostPort('win32', 'C:\\Users\\a', () => xml)).toBe(3874)
    expect(backgroundHostPort('linux', '/home/a', () => Buffer.from('serve --port 5000'))).toBe(
      5000,
    )
    expect(
      backgroundHostPort('linux', '/home/a', () => {
        throw new Error('ENOENT')
      }),
    ).toBeNull()
    expect(backgroundHostPort('darwin', '/Users/a')).toBeNull()
  })
})
