import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { doctor, doctorExitCode, formatChecks, type DoctorDeps } from './doctor.ts'
import { fetchHealth } from './health.ts'
import { hostLogPath, logs, tail } from './logs.ts'
import { status } from './status.ts'

const HEALTH = { name: 'My PC', version: '1.2.3', platform: 'win32', protocol: 4 }

const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  port: 3773,
  health: async () => HEALTH,
  find: (name) => `/bin/${name}`,
  run: async () => ({ code: 0, stdout: 'v1\n', stderr: '' }),
  tailnet: async () => ({
    state: 'running',
    peers: [],
    self: { name: 'pc', dnsName: 'pc.ts.net', ip: '100.1.1.1' },
  }),
  dataDir: '/home/me/.beddcode',
  dirExists: () => true,
  ...over,
})

describe('fetchHealth and status', () => {
  const fake = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch

  it('reads what the host says about itself', async () => {
    const health = await fetchHealth(
      3773,
      fake({ ok: true, protocol: 4, host: { name: 'My PC', version: '1.2.3', platform: 'win32' } }),
    )
    expect(health).toEqual(HEALTH)
  })

  it('is null when nothing answers or the answer is not a host', async () => {
    const refused = (async () => Promise.reject(new Error('refused'))) as unknown as typeof fetch
    expect(await fetchHealth(1, refused)).toBeNull()
    expect(await fetchHealth(1, fake({ ok: false }))).toBeNull()
    expect(await fetchHealth(1, fake({}, false))).toBeNull()
  })

  it('exits 1 with a hint when there is no host', async () => {
    const lines: string[] = []
    // Port 1 is never a BeddCode host.
    expect(await status(1, (l) => lines.push(l))).toBe(1)
    expect(lines.join('\n')).toContain('beddcode serve')
  })
})

describe('doctor', () => {
  it('reports a healthy machine without any fix hints', async () => {
    const checks = await doctor(deps())
    expect(checks.every((c) => c.level === 'ok')).toBe(true)
    expect(doctorExitCode(checks)).toBe(0)
    expect(formatChecks(checks)).not.toContain('→')
  })

  it('fails when git or every agent is missing, and says how to fix it', async () => {
    const checks = await doctor(deps({ find: () => null }))
    const failed = checks.filter((c) => c.level === 'fail').map((c) => c.name)
    expect(failed).toEqual(['git', 'Agents'])
    expect(doctorExitCode(checks)).toBe(1)
    expect(formatChecks(checks)).toContain('→ Install git')
  })

  it('checks the background host when asked to', async () => {
    const find = async (installed: boolean, up: boolean) =>
      (
        await doctor(
          deps({
            serviceInstalled: async () => installed,
            platform: 'win32',
            ...(up ? {} : { health: async () => null }),
          }),
        )
      ).find((c) => c.name === 'Background host')
    expect(await find(false, true)).toMatchObject({
      level: 'ok',
      detail: expect.stringMatching(/not installed/),
    })
    expect(await find(true, true)).toMatchObject({
      level: 'ok',
      detail: expect.stringMatching(/^installed/),
    })
    expect(await find(true, false)).toMatchObject({
      level: 'warn',
      fix: expect.stringContaining('schtasks /Run /TN "BeddCode Server"'),
    })
    expect((await doctor(deps())).some((c) => c.name === 'Background host')).toBe(false)
  })

  it('only warns for what is optional', async () => {
    const checks = await doctor(
      deps({
        health: async () => null,
        find: (name) => (name === 'git' || name === 'claude' ? `/bin/${name}` : null),
        tailnet: async () => ({ state: 'not-installed', peers: [] }),
        dirExists: () => false,
      }),
    )
    expect(checks.filter((c) => c.level === 'fail')).toEqual([])
    expect(checks.filter((c) => c.level === 'warn').map((c) => c.name)).toEqual([
      'Host',
      'codex',
      'grok',
      'GitHub',
      'Tailscale',
      'Data',
    ])
  })

  it('treats a program that will not run as missing, and never throws', async () => {
    const checks = await doctor(
      deps({
        run: async () => {
          throw new Error('spawn failed')
        },
        tailnet: async () => {
          throw new Error('no tailscale')
        },
      }),
    )
    expect(checks.find((c) => c.name === 'git')?.level).toBe('fail')
    expect(checks.find((c) => c.name === 'Tailscale')?.level).toBe('warn')
  })
})

describe('logs', () => {
  it('finds the app log per platform', () => {
    const roaming = 'C:\\Users\\me\\AppData\\Roaming'
    expect(hostLogPath({ APPDATA: roaming }, 'win32', 'C:\\Users\\me')).toBe(
      path.join(roaming, 'BeddCode', 'logs', 'host.log'),
    )
    expect(hostLogPath({}, 'linux', '/home/me')).toBe(
      path.join('/home/me', '.config', 'BeddCode', 'logs', 'host.log'),
    )
    expect(hostLogPath({ BEDDCODE_LOG_FILE: '/tmp/x.log' }, 'linux', '/home/me')).toBe('/tmp/x.log')
  })

  it('keeps the last lines', () => {
    expect(tail('a\nb\r\nc\n\nd\n', 2)).toBe('c\nd')
  })

  it('prints the end of a log, and says so when there is none', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bc-logs-'))
    try {
      const file = path.join(dir, 'host.log')
      writeFileSync(file, 'one\ntwo\nthree\n')
      const out: string[] = []
      expect(logs(file, { lines: 2, follow: false }, (t) => out.push(t))).toBe(0)
      expect(out).toEqual(['two\nthree'])
      expect(logs(path.join(dir, 'missing.log'), { lines: 2, follow: false })).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
