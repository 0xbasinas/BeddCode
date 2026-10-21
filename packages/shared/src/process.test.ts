import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveExecutable } from './process.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function pathWith(files: string[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-path-'))
  dirs.push(dir)
  for (const f of files) writeFileSync(path.join(dir, f), '')
  return { dir, env: { PATH: dir, PATHEXT: '.EXE;.CMD' } as NodeJS.ProcessEnv }
}

describe('resolveExecutable', () => {
  it('returns null when nothing matches', () => {
    expect(resolveExecutable('nope', pathWith([]).env)).toBeNull()
  })

  it.runIf(process.platform === 'win32')(
    'prefers a runnable PATHEXT match over an extensionless shim on Windows',
    () => {
      const { dir, env } = pathWith(['npx', 'npx.cmd'])
      expect(resolveExecutable('npx', env)).toBe(path.join(dir, 'npx.cmd'))
    },
  )

  it.runIf(process.platform === 'win32')(
    'ignores an extensionless file with no runnable twin',
    () => {
      expect(resolveExecutable('tool', pathWith(['tool']).env)).toBeNull()
    },
  )

  it.runIf(process.platform !== 'win32')('finds a plain executable on POSIX', () => {
    const { dir, env } = pathWith(['tool'])
    expect(resolveExecutable('tool', env)).toBe(path.join(dir, 'tool'))
  })

  it('accepts an absolute path that exists', () => {
    const { dir } = pathWith(['x.exe'])
    expect(resolveExecutable(path.join(dir, 'x.exe'))).toBe(path.join(dir, 'x.exe'))
    expect(resolveExecutable(path.join(dir, 'missing.exe'))).toBeNull()
  })
})
