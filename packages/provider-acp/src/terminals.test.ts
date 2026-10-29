import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OUTPUT_LIMIT, MAX_OUTPUT_LIMIT, TerminalManager, trimOutput } from './terminals.ts'

describe('ACP terminal output', () => {
  it('keeps complete characters and honours zero and small byte limits', () => {
    expect(trimOutput('a🙂b', 5)).toBe('🙂b')
    expect(trimOutput('a🙂b', 4)).toBe('b')
    expect(trimOutput('hello', 0)).toBe('')
  })

  it('decodes split UTF-8 output and truncates on a character boundary', async () => {
    const terminals = new TerminalManager(os.tmpdir())
    const program =
      "const b=Buffer.from('A🙂Z');process.stdout.write(b.subarray(0,3));setTimeout(()=>process.stdout.write(b.subarray(3)),10)"
    const { terminalId } = terminals.create({
      command: process.execPath,
      args: ['-e', program],
      outputByteLimit: 5,
    })
    try {
      await terminals.waitForExit(terminalId)
      expect(terminals.output(terminalId)).toMatchObject({ output: '🙂Z', truncated: true })
    } finally {
      terminals.releaseAll()
    }
  })

  it('bounds output by default, even if an agent asks for more', async () => {
    const terminals = new TerminalManager(os.tmpdir())
    const program = `process.stdout.write('x'.repeat(${MAX_OUTPUT_LIMIT + 32}))`
    const first = terminals.create({ command: process.execPath, args: ['-e', program] }).terminalId
    const second = terminals.create({
      command: process.execPath,
      args: ['-e', program],
      outputByteLimit: MAX_OUTPUT_LIMIT * 2,
    }).terminalId
    try {
      await Promise.all([terminals.waitForExit(first), terminals.waitForExit(second)])
      expect(terminals.output(first).output.length).toBe(DEFAULT_OUTPUT_LIMIT)
      expect(terminals.output(second).output.length).toBe(MAX_OUTPUT_LIMIT)
      expect(terminals.output(first).truncated).toBe(true)
      expect(terminals.output(second).truncated).toBe(true)
    } finally {
      terminals.releaseAll()
    }
  })

  it('rejects invalid limits and relative working directories', () => {
    const terminals = new TerminalManager(os.tmpdir())
    expect(() => terminals.create({ command: process.execPath, outputByteLimit: -1 })).toThrow(
      'non-negative integer',
    )
    expect(() => terminals.create({ command: process.execPath, cwd: 'relative' })).toThrow(
      'absolute path',
    )
  })
})
