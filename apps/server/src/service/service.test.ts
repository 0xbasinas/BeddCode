import { describe, expect, it } from 'vitest'
import { planService } from './install.ts'

describe('planService', () => {
  it('builds a systemd user unit that keeps the host running', () => {
    const plan = planService({
      platform: 'linux',
      home: '/home/me',
      command: ['/usr/bin/node', '/opt/beddcode/main.js'],
      serveArgs: ['--host', '0.0.0.0'],
    })
    const unit = plan.files[0]!
    expect(unit.path).toBe('/home/me/.config/systemd/user/beddcode-server.service')
    expect(unit.content).toContain(
      'ExecStart=/usr/bin/node /opt/beddcode/main.js serve --host 0.0.0.0',
    )
    expect(unit.content).toContain('Restart=on-failure')
    expect(unit.content).toContain('WantedBy=default.target')
    expect(plan.install.at(-1)).toEqual([
      'systemctl',
      '--user',
      'enable',
      '--now',
      'beddcode-server.service',
    ])
    expect(plan.remove).toEqual([unit.path])
    expect(plan.notes.join('\n')).toContain('enable-linger')
  })

  it('quotes paths with spaces for systemd', () => {
    const plan = planService({
      platform: 'linux',
      home: '/home/me',
      command: ['/opt/my apps/node', '/srv/b"c/main.js'],
      serveArgs: [],
    })
    expect(plan.files[0]!.content).toContain(
      'ExecStart="/opt/my apps/node" "/srv/b\\"c/main.js" serve',
    )
  })

  it('creates a logon task on Windows, quoting paths with spaces', () => {
    const plan = planService({
      platform: 'win32',
      home: 'C:\\Users\\me',
      command: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\beddcode\\main.js'],
      serveArgs: ['--host', '0.0.0.0', '--port', '4000'],
    })
    const create = plan.install[0]!
    expect(create.slice(0, 4)).toEqual(['schtasks', '/Create', '/TN', 'BeddCode Server'])
    expect(create[5]).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" C:\\beddcode\\main.js serve --host 0.0.0.0 --port 4000',
    )
    expect(create).toContain('ONLOGON')
    expect(plan.uninstall.at(-1)).toEqual(['schtasks', '/Delete', '/TN', 'BeddCode Server', '/F'])
    expect(plan.files).toEqual([])
  })

  it('refuses platforms it does not support', () => {
    expect(() =>
      planService({ platform: 'darwin', home: '/Users/me', command: [], serveArgs: [] }),
    ).toThrow(/Linux and Windows/)
  })
})

describe('planService with an environment', () => {
  const env = { ELECTRON_RUN_AS_NODE: '1', BEDDCODE_WEB_ROOT: '/opt/BeddCode/resources/web' }

  it('sets it in the systemd unit', () => {
    const plan = planService({
      platform: 'linux',
      home: '/home/me',
      command: ['/opt/BeddCode/beddcode', '/opt/BeddCode/resources/server/main.mjs'],
      serveArgs: [],
      env,
    })
    const unit = plan.files[0]!.content
    expect(unit).toContain('Environment=ELECTRON_RUN_AS_NODE=1')
    expect(unit).toContain('Environment=BEDDCODE_WEB_ROOT=/opt/BeddCode/resources/web')
  })

  it('has cmd set it before the scheduled task starts the host', () => {
    const plan = planService({
      platform: 'win32',
      home: 'C:\\Users\\me',
      command: ['C:\\Apps\\BeddCode.exe', 'C:\\Apps\\resources\\server\\main.mjs'],
      serveArgs: [],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
    const task = plan.install[0]!
    expect(task[task.indexOf('/TR') + 1]).toMatch(
      /^cmd \/d \/c ".*set "ELECTRON_RUN_AS_NODE=1" && /,
    )
  })

  it('changes nothing without one', () => {
    const plan = planService({
      platform: 'linux',
      home: '/home/me',
      command: ['/usr/bin/node', '/x.js'],
      serveArgs: [],
    })
    expect(plan.files[0]!.content).not.toContain('Environment=')
  })
})
