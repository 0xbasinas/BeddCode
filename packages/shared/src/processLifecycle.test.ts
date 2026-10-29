import { describe, expect, it } from 'vitest'
import {
  killAllChildren,
  runCommand,
  runningChildren,
  spawnProcess,
  stopProcess,
} from './process.ts'
import { spawnTransport } from './jsonrpc.ts'
import { withTimeout } from './async.ts'

const node = process.execPath
const posix = process.platform !== 'win32'

describe('stopProcess', () => {
  it('lets a child that exits on end of input do so, without a kill', async () => {
    const child = spawnProcess(node, [
      '-e',
      'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))',
    ])
    await new Promise((r) => setTimeout(r, 100))
    await stopProcess(child, { graceMs: 5_000 })
    expect(child.exitCode).toBe(0)
  })

  it.skipIf(!posix)('kills a child that ignores both its input closing and SIGTERM', async () => {
    const child = spawnProcess(node, [
      '-e',
      'process.on("SIGTERM", () => {}); process.stdin.on("end", () => {}); setInterval(() => {}, 1000); console.log("up")',
    ])
    await new Promise((r) => child.stdout.once('data', r))
    const started = Date.now()
    await stopProcess(child, { graceMs: 200 })
    expect(child.signalCode).toBe('SIGKILL')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('forgets children once they exit, and kills any left on shutdown', async () => {
    const before = runningChildren()
    const child = spawnProcess(node, ['-e', 'setInterval(() => {}, 1000)'])
    expect(runningChildren()).toBe(before + 1)
    const exited = new Promise((r) => child.once('exit', r))
    killAllChildren()
    await exited
    expect(runningChildren()).toBe(0)
  })
})

describe('spawnTransport', () => {
  it('reports the close of a process whose grandchild still holds its output open', async () => {
    // The child starts a long-lived grandchild that inherits stdout, then dies.
    const script = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' }); setTimeout(() => process.exit(1), 50)`
    const transport = spawnTransport(node, ['-e', script], {})
    const closed = new Promise<void>((r) => transport.onClose(r))
    await withTimeout(closed, 5_000, 'onClose')
    transport.close()
  })

  it('ignores writes after the process has gone', async () => {
    const transport = spawnTransport(node, ['-e', 'process.exit(0)'], {})
    await new Promise<void>((r) => transport.onClose(r))
    expect(() => transport.send('{"jsonrpc":"2.0","method":"x"}')).not.toThrow()
  })
})

describe('withTimeout', () => {
  it('passes a result through and rejects a promise that takes too long', async () => {
    await expect(withTimeout(Promise.resolve(1), 50)).resolves.toBe(1)
    await expect(withTimeout(new Promise(() => {}), 20, 'close')).rejects.toThrow(
      /close did not finish within 20 ms/,
    )
  })
})

describe('runCommand', () => {
  it('gives a command no input to wait for, so one that reads it to the end still finishes', async () => {
    // Like PowerShell: reads stdin before it exits.
    const res = await runCommand(
      process.execPath,
      ['-e', 'process.stdin.resume(); process.stdin.on("end", () => { console.log("done") })'],
      { timeoutMs: 5_000 },
    )
    expect(res).toMatchObject({ code: 0, stdout: expect.stringContaining('done') })
  })

  it('reports the exit code, and gives up on a command that runs too long', async () => {
    expect(await runCommand(process.execPath, ['-e', 'process.exit(3)'])).toMatchObject({ code: 3 })
    await expect(
      runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/)
  })
})
