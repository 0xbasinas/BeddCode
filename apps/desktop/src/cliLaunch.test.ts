import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliLaunch, type CliContext } from './cliLaunch.ts'

const context = (argv: string[], over: Partial<CliContext> = {}): CliContext => ({
  argv: ['/opt/BeddCode/beddcode', ...argv],
  packaged: true,
  defaultApp: false,
  resourcesPath: '/opt/BeddCode/resources',
  execPath: '/opt/BeddCode/beddcode',
  ...over,
})

describe('cliLaunch', () => {
  it('runs the host script on the app runtime for a command', () => {
    const spec = cliLaunch(context(['status', '--port', '4000']))!
    expect(spec.command).toBe('/opt/BeddCode/beddcode')
    expect(spec.args).toEqual([
      path.join('/opt/BeddCode/resources', 'server', 'main.mjs'),
      'status',
      '--port',
      '4000',
    ])
    expect(spec.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      BEDDCODE_APP: '/opt/BeddCode/beddcode',
      BEDDCODE_WEB_ROOT: path.join('/opt/BeddCode/resources', 'web'),
    })
  })

  it('leaves an ordinary launch alone', () => {
    expect(cliLaunch(context([]))).toBeNull()
    expect(cliLaunch(context(['open']))).not.toBeNull()
    expect(cliLaunch(context(['/some/folder']))).toBeNull()
    expect(cliLaunch(context(['--some-chromium-flag']))).toBeNull()
  })

  it('is off when running from source', () => {
    expect(cliLaunch(context(['status'], { packaged: false }))).toBeNull()
  })

  it('reads arguments after the app path when started as electron <app>', () => {
    const spec = cliLaunch(context([], { argv: ['electron', '/app', 'doctor'], defaultApp: true }))!
    expect(spec.args.at(-1)).toBe('doctor')
  })
})
