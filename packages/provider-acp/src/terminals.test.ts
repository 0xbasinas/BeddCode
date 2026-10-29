import { describe, expect, it } from 'vitest'
import type { AgentCommandRequest, AgentTerminalHost } from '@beddcode/provider-core'
import { TerminalManager } from './terminals.ts'

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
