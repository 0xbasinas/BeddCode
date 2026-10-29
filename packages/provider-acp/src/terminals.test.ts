import os from 'node:os'
import type { AgentCommandRequest, AgentTerminalHost } from '@beddcode/provider-core'
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

describe('TerminalManager with a terminal host', () => {
  it('runs every terminal through the host and forwards each call', async () => {
    const requests: AgentCommandRequest[] = []
    const calls: string[] = []
    const host: AgentTerminalHost = {
      run(req) {
        requests.push(req)
        return {
          output: () => ({
            output: 'hi\n',
            truncated: false,
            exitStatus: { exitCode: 0, signal: null },
          }),
          waitForExit: async () => ({ exitCode: 0, signal: null }),
          kill: () => void calls.push('kill'),
          release: () => void calls.push('release'),
        }
      },
    }
    const terminals = new TerminalManager('/repo', host)
    const { terminalId } = terminals.create({
      command: "bash -lc 'echo hi'",
      env: [{ name: 'CI', value: 'true' }],
      outputByteLimit: 100,
    })
    expect(requests).toEqual([
      {
        command: "bash -lc 'echo hi'",
        args: undefined,
        env: { CI: 'true' },
        cwd: '/repo',
        outputByteLimit: 100,
      },
    ])
    await expect(terminals.waitForExit(terminalId)).resolves.toMatchObject({ exitCode: 0 })
    expect(terminals.output(terminalId)).toMatchObject({ output: 'hi\n', truncated: false })
    terminals.kill(terminalId)
    terminals.release(terminalId)
    expect(calls).toEqual(['kill', 'release'])
    expect(() => terminals.output(terminalId)).toThrow()
  })

  it('releases hosted terminals with the session', () => {
    const released: string[] = []
    const host: AgentTerminalHost = {
      run: (req) => ({
        output: () => ({ output: '', truncated: false, exitStatus: null }),
        waitForExit: () => new Promise(() => {}),
        kill: () => {},
        release: () => void released.push(req.command),
      }),
    }
    const terminals = new TerminalManager('/repo', host)
    terminals.create({ command: 'sleep 1' })
    terminals.create({ command: 'sleep 2' })
    terminals.releaseAll()
    expect(released).toEqual(['sleep 1', 'sleep 2'])
  })
})
