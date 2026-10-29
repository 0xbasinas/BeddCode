import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectEditors, editorArgs } from './editors.ts'

const cursor = { id: 'cursor', baseArgs: ['--classic'], launchStyle: 'goto' as const }
const zed = { id: 'zed', baseArgs: [], launchStyle: 'direct-path' as const }
const idea = { id: 'idea', baseArgs: [], launchStyle: 'line-column' as const }
const files = { id: 'file-manager', baseArgs: [], launchStyle: 'direct-path' as const }
const cwd = path.resolve('/work/app')
const file = path.join(cwd, 'src', 'main.ts')

describe('editorArgs', () => {
  it('opens just the folder when no file is given', () => {
    expect(editorArgs(cursor, { cwd })).toEqual(['--classic', cwd])
    expect(editorArgs(idea, { cwd })).toEqual([cwd])
  })

  it('opens a file at a line in VS Code-style editors with --goto, alongside the folder', () => {
    expect(editorArgs(cursor, { cwd, path: 'src/main.ts', line: 12, column: 3 })).toEqual([
      '--classic',
      cwd,
      '--goto',
      `${file}:12:3`,
    ])
    expect(editorArgs(cursor, { cwd, path: 'src/main.ts' })).toEqual(['--classic', cwd, file])
  })

  it('passes path:line straight to Zed', () => {
    expect(editorArgs(zed, { cwd, path: file, line: 7 })).toEqual([cwd, `${file}:7`])
  })

  it('uses --line and a zero-based --column for JetBrains IDEs', () => {
    expect(editorArgs(idea, { cwd, path: 'src/main.ts', line: 4, column: 10 })).toEqual([
      '--line',
      '4',
      '--column',
      '9',
      file,
    ])
  })

  it('opens the containing folder in the file manager', () => {
    expect(editorArgs(files, { cwd, path: 'src/main.ts', line: 2 })).toEqual([path.dirname(file)])
  })
})

describe('detectEditors', () => {
  it('finds editors on PATH and in install folders, preferred first', () => {
    const present = new Set([
      path.join('/opt/bin', 'code'),
      path.join('/home/me/.local/bin', 'zeditor'),
      path.join('/usr/bin', 'xdg-open'),
    ])
    const found = detectEditors({
      platform: 'linux',
      env: { PATH: '/opt/bin', HOME: '/home/me', DISPLAY: ':0' },
      isFile: (p) => present.has(p),
    })
    expect(found.map((e) => e.id)).toEqual(['vscode', 'zed'])
    expect(found[1]!.command).toBe(path.join('/home/me/.local/bin', 'zeditor'))
  })

  it('offers the file manager only with a desktop session', () => {
    const present = new Set([path.join('/usr/bin', 'xdg-open')])
    const host = (env: NodeJS.ProcessEnv) =>
      detectEditors({
        platform: 'linux',
        env: { PATH: '/usr/bin', ...env },
        isFile: (p) => present.has(p),
      })
    expect(host({ DISPLAY: ':1' }).map((e) => e.id)).toEqual(['file-manager'])
    expect(host({})).toEqual([])
  })

  it('finds Windows .cmd shims of GUI installs that are not on PATH', () => {
    const shim = path.join(
      'C:/Users/me/AppData/Local',
      'Programs',
      'cursor',
      'resources/app/bin',
      'cursor.cmd',
    )
    const found = detectEditors({
      platform: 'win32',
      env: { PATH: '', LOCALAPPDATA: 'C:/Users/me/AppData/Local' },
      isFile: (p) =>
        p === shim ||
        p ===
          path.join(
            'C:/Users/me/AppData/Local',
            'Programs',
            'Cursor',
            'resources/app/bin',
            'cursor.cmd',
          ),
    })
    expect(found.map((e) => e.id)).toEqual(['cursor', 'file-manager'])
  })
})
