import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostPort, serverLaunch } from './serverLaunch.ts'

const base = {
  packaged: false,
  resourcesPath: '/app/resources',
  execPath: '/app/beddcode',
  serverDir: '/repo/apps/server',
  env: {},
}

describe('hostPort', () => {
  it('is 3773 unless a sensible port is asked for', () => {
    expect(hostPort({})).toBe(3773)
    expect(hostPort({ BEDDCODE_PORT: '4100' })).toBe(4100)
    expect(hostPort({ BEDDCODE_PORT: 'abc' })).toBe(3773)
    expect(hostPort({ BEDDCODE_PORT: '99999' })).toBe(3773)
  })
})

describe('serverLaunch', () => {
  it('runs the sources with Node from the source tree', () => {
    expect(serverLaunch(base)).toEqual({
      command: 'node',
      args: ['--import', 'tsx', 'src/main.ts', '--port', '3773'],
      cwd: '/repo/apps/server',
    })
  })

  it("runs the built host with the app's own runtime when installed", () => {
    const spec = serverLaunch({ ...base, packaged: true })
    expect(spec.command).toBe('/app/beddcode')
    expect(spec.args[0]).toBe(path.join(base.resourcesPath, 'server', 'main.mjs'))
    expect(spec.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      BEDDCODE_WEB_ROOT: path.join(base.resourcesPath, 'web'),
    })
  })

  it('lets a script be named explicitly, and keeps the port', () => {
    const spec = serverLaunch({
      ...base,
      env: { BEDDCODE_SERVER_ENTRY: '/x/main.mjs', BEDDCODE_PORT: '4100' },
    })
    expect(spec.args).toEqual(['/x/main.mjs', '--port', '4100'])
  })
})
