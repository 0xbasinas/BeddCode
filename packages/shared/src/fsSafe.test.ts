import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readJsonFile, writeFileAtomic } from './fsSafe.ts'

const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-fssafe-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('replaces a file in one step, creating its folder and leaving no temp files', () => {
    const dir = temp()
    const file = path.join(dir, 'nested', 'state.json')
    writeFileAtomic(file, '{"a":1}')
    writeFileAtomic(file, '{"a":2}')
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}')
    expect(readdirSync(path.dirname(file))).toEqual(['state.json'])
  })

  it.skipIf(process.platform === 'win32')(
    'applies the mode asked for (secrets stay private)',
    () => {
      const file = path.join(temp(), 'auth.json')
      writeFileAtomic(file, '{}', { mode: 0o600 })
      expect(statSync(file).mode & 0o777).toBe(0o600)
    },
  )

  it('leaves the old file intact when the write fails', () => {
    const dir = temp()
    const file = path.join(dir, 'state.json')
    writeFileSync(file, '{"ok":true}')
    // A folder where the file should go makes the rename fail.
    const blocked = path.join(dir, 'blocked')
    writeFileAtomic(path.join(blocked, 'x'), '1')
    expect(() => writeFileAtomic(blocked, 'nope')).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{"ok":true}')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('readJsonFile', () => {
  it('tells a missing file from a good one', () => {
    const dir = temp()
    expect(readJsonFile(path.join(dir, 'none.json'))).toEqual({ status: 'missing' })
    writeFileSync(path.join(dir, 'ok.json'), '{"a":1}')
    expect(readJsonFile(path.join(dir, 'ok.json'))).toEqual({ status: 'ok', value: { a: 1 } })
  })

  it('moves a corrupt or empty file aside so the next write does not lose it', () => {
    const dir = temp()
    for (const [name, text] of <[string, string][]>[
      ['torn.json', '{"devices":[{"id":'],
      ['empty.json', ''],
    ]) {
      const file = path.join(dir, name)
      writeFileSync(file, text)
      const result = readJsonFile(file)
      expect(result.status).toBe('corrupt')
      if (result.status !== 'corrupt') continue
      const moved = result.quarantined ?? ''
      expect(moved).toMatch(new RegExp(`${name}\\.corrupt-`))
      expect(readFileSync(moved, 'utf8')).toBe(text)
      expect(readJsonFile(file)).toEqual({ status: 'missing' })
    }
  })
})
