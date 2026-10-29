import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseServeArgs } from '../config.ts'
import { configCmd, parseValue, settingKey } from './configCmd.ts'
import { HANDLERS } from './dispatch.ts'
import type { Io } from './io.ts'
import { filterLevel, parseLevel } from './logs.ts'
import { formatReport, redact } from './report.ts'
import { completionScript, SPECS } from './spec.ts'
import { compareVersions, pickAsset } from './update.ts'

function fakeIo() {
  const out: string[] = []
  const err: string[] = []
  const io: Io = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    interactive: false,
    ask: async () => '',
  }
  return { io, out, err }
}

describe('completion', () => {
  it('knows every command the CLI has', () => {
    const known = new Set(SPECS.map((s) => s.name))
    for (const name of Object.keys(HANDLERS)) expect(known.has(name), name).toBe(true)
    for (const name of ['serve', 'install-service', 'uninstall-service', 'host']) {
      expect(known.has(name), name).toBe(true)
    }
  })

  it('writes a script for each shell with the commands in it', () => {
    for (const shell of ['bash', 'zsh', 'fish', 'powershell']) {
      const script = completionScript(shell)
      expect(script).toContain('schedule')
      expect(script).toContain('completion')
    }
    expect(completionScript('bash')).toContain('complete -F _beddcode beddcode')
    expect(completionScript('powershell')).toContain('Register-ArgumentCompleter')
  })

  it('refuses a shell it does not know', () => {
    expect(() => completionScript('tcsh')).toThrow(/Shells/)
  })
})

describe('redact', () => {
  it('removes tokens, codes and the home folder', () => {
    const text = [
      'Authorization: Bearer abcdef1234567890',
      'GET /pair?code=482913&x=1',
      'token=supersecretvalue',
      'opened C:\\Users\\jo\\proj and C:/Users/jo/other',
      'plain line',
    ].join('\n')
    const out = redact(text, 'C:\\Users\\jo')
    expect(out).not.toContain('abcdef1234567890')
    expect(out).not.toContain('482913')
    expect(out).not.toContain('supersecretvalue')
    expect(out).not.toContain('jo')
    expect(out).toContain('~\\proj')
    expect(out).toContain('~/other')
    expect(out).toContain('plain line')
  })

  it('formats a report with its sections', () => {
    const text = formatReport({
      version: '1.2.3',
      platform: 'x',
      node: 'v22',
      checks: '✓ Host',
      log: '',
      now: new Date('2026-01-02T00:00:00Z'),
    })
    expect(text).toContain('BeddCode: 1.2.3')
    expect(text).toContain('(no log)')
  })
})

describe('update', () => {
  it('compares versions', () => {
    expect(compareVersions('v0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1)
    expect(compareVersions('1.0.0', '0.0.0-dev')).toBe(1)
  })

  it('picks the installer for the system', () => {
    const assets = [
      { name: 'BeddCode-Setup-0.2.0-x64.exe', browser_download_url: 'a' },
      { name: 'BeddCode-Setup-0.2.0-x64.exe.blockmap', browser_download_url: 'b' },
      { name: 'BeddCode-0.2.0-x86_64.AppImage', browser_download_url: 'c' },
      { name: 'beddcode_0.2.0_amd64.deb', browser_download_url: 'd' },
      { name: 'BeddCode-0.2.0-arm64.dmg', browser_download_url: 'e' },
    ]
    expect(pickAsset(assets, 'win32', 'x64')?.browser_download_url).toBe('a')
    expect(pickAsset(assets, 'linux', 'x64')?.browser_download_url).toBe('c')
    expect(pickAsset(assets, 'linux', 'x64', true)?.browser_download_url).toBe('d')
    expect(pickAsset(assets, 'darwin', 'arm64')?.browser_download_url).toBe('e')
  })

  it('picks the host archive for a host installed on its own', () => {
    const assets = [
      { name: 'BeddCode-Setup-0.2.0-x64.exe', browser_download_url: 'a' },
      { name: 'beddcode-host-win-x64.zip', browser_download_url: 'w' },
      { name: 'beddcode-host-linux-x64.tar.gz', browser_download_url: 'l' },
    ]
    expect(pickAsset(assets, 'win32', 'x64', false, true)?.browser_download_url).toBe('w')
    expect(pickAsset(assets, 'linux', 'x64', false, true)?.browser_download_url).toBe('l')
  })
})

describe('logs level', () => {
  const log = [
    '2026-01-01T00:00:00Z INFO started',
    '2026-01-01T00:00:01Z WARN slow',
    '2026-01-01T00:00:02Z ERROR boom',
    '  at stack line',
    '2026-01-01T00:00:03Z DEBUG noise',
  ].join('\n')

  it('keeps lines at or above the level, with their stack', () => {
    const out = filterLevel(log, 'warn').split('\n')
    expect(out).toEqual([
      '2026-01-01T00:00:01Z WARN slow',
      '2026-01-01T00:00:02Z ERROR boom',
      '  at stack line',
    ])
  })

  it('accepts warning and rejects nonsense', () => {
    expect(parseLevel('Warning')).toBe('warn')
    expect(() => parseLevel('loud')).toThrow(/--level/)
  })
})

describe('config', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))
  const file = () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'bc-config-'))
    return path.join(dir, 'config.json')
  }

  it('sets, gets and unsets', () => {
    const f = file()
    const { io, out } = fakeIo()
    expect(configCmd(['set', 'allow-lan', 'on'], io, f)).toBe(0)
    expect(configCmd(['set', 'port', '4000'], io, f)).toBe(0)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ allowLan: true, port: 4000 })
    expect(configCmd(['get', 'port'], io, f)).toBe(0)
    expect(out.at(-1)).toBe('4000\n')
    configCmd(['unset', 'port'], io, f)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ allowLan: true })
    expect(configCmd(['get', 'port'], io, f)).toBe(1)
  })

  it('rejects bad names and values', () => {
    expect(() => settingKey('colour')).toThrow(/Unknown setting/)
    expect(() => parseValue('port', 'abc')).toThrow(/port/)
    expect(() => parseValue('allowLan', 'maybe')).toThrow(/on or off/)
    expect(parseValue('allowedOrigins', 'a, b')).toEqual(['a', 'b'])
  })

  it('is overridden by variables, then flags', () => {
    const fromFile = { port: 4000, host: '0.0.0.0', allowLan: true }
    expect(parseServeArgs([], {}, fromFile)).toMatchObject({ port: 4000, host: '0.0.0.0' })
    expect(parseServeArgs([], { BEDDCODE_PORT: '5000' }, fromFile).port).toBe(5000)
    expect(parseServeArgs(['--port', '6000'], { BEDDCODE_PORT: '5000' }, fromFile).port).toBe(6000)
    expect(parseServeArgs([], {}, fromFile).guard.allowLan).toBe(true)
    expect(parseServeArgs([], { BEDDCODE_ALLOW_LAN: '0' }, fromFile).guard.allowLan).toBe(false)
  })
})
