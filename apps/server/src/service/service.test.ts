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

  it('creates a windowless logon task on Windows, quoting paths with spaces', () => {
    const plan = planService({
      platform: 'win32',
      home: 'C:\\Users\\me',
      command: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\beddcode\\main.js'],
      serveArgs: ['--host', '0.0.0.0', '--port', '4000'],
      user: 'PC\\me',
    })
    const xmlPath = 'C:\\Users\\me\\AppData\\Local\\BeddCode\\host-task.xml'
    expect(plan.install[0]).toEqual([
      'schtasks',
      '/Create',
      '/TN',
      'BeddCode Server',
      '/XML',
      xmlPath,
      '/F',
    ])
    const file = plan.files[0]!
    expect(file.path).toBe(xmlPath)
    expect(file.utf16).toBe(true)
    const xml = file.content
    expect(xml).toContain(
      '<Command>%SystemRoot%\\System32\\conhost.exe</Command><Arguments>--headless &#34;C:\\Program Files\\nodejs\\node.exe&#34; C:\\beddcode\\main.js serve --host 0.0.0.0 --port 4000</Arguments>',
    )
    expect(xml).toContain(
      '<LogonTrigger><Enabled>true</Enabled><UserId>PC\\me</UserId></LogonTrigger>',
    )
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
    // No 72-hour limit, restarted when it fails, kept on battery.
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(xml).toContain('<RestartOnFailure>')
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
    expect(plan.uninstall.at(-1)).toEqual(['schtasks', '/Delete', '/TN', 'BeddCode Server', '/F'])
    expect(plan.remove).toEqual([xmlPath])
  })

  it('starts with Windows, signed in or not, with --at-boot', () => {
    const plan = planService({
      platform: 'win32',
      home: 'C:\\Users\\me',
      command: ['node.exe', 'main.js'],
      serveArgs: [],
      user: 'PC\\me',
      atBoot: true,
    })
    const xml = plan.files[0]!.content
    expect(xml).toContain('<BootTrigger>')
    expect(xml).not.toContain('<LogonTrigger>')
    expect(xml).toContain('<LogonType>S4U</LogonType>')
  })

  it('keeps the user services running without a session on Linux with --at-boot', () => {
    const plan = planService({
      platform: 'linux',
      home: '/home/me',
      command: ['/usr/bin/node', '/x.js'],
      serveArgs: [],
      user: 'me',
      atBoot: true,
    })
    expect(plan.install.at(-1)).toEqual(['loginctl', 'enable-linger', 'me'])
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
    expect(plan.files[0]!.content).toContain(
      '<Arguments>--headless cmd.exe /d /c &#34;set &#34;ELECTRON_RUN_AS_NODE=1&#34; &#38;&#38; C:\\Apps\\BeddCode.exe',
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
