import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireHostLock, listenError } from './hostLock.ts'

const dirs: string[] = []
const home = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-lock-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('acquireHostLock', () => {
  it('takes a free folder, and gives it back on release', async () => {
    const dir = home()
    const lock = await acquireHostLock(dir, 1234)
    expect(JSON.parse(readFileSync(lock.file, 'utf8'))).toMatchObject({
      pid: process.pid,
      port: 1234,
    })
    lock.release()
    expect(existsSync(lock.file)).toBe(false)
  })

  it('takes over the lock of a host that was killed, or an unreadable one', async () => {
    const dir = home()
    const gone = spawnSync(process.execPath, ['-e', '0']).pid
    writeFileSync(
      path.join(dir, 'host.lock'),
      JSON.stringify({ pid: gone, port: 1, startedAt: Date.now() }),
    )
    ;(await acquireHostLock(dir, 2)).release()
    writeFileSync(path.join(dir, 'host.lock'), 'garbage')
    ;(await acquireHostLock(dir, 2)).release()
  })

  it('takes over a lock whose process id now belongs to another program', async () => {
    const dir = home()
    // Alive, but not a host: it did not start an hour ago, and it is not node either (on Windows
    // without readable start times, the program name decides).
    const other =
      process.platform === 'win32'
        ? spawn('ping', ['-n', '30', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
        : spawn('sleep', ['30'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(
      path.join(dir, 'host.lock'),
      JSON.stringify({ pid: other.pid, port: 1, startedAt: Date.now() - 3_600_000 }),
    )
    ;(await acquireHostLock(dir, 2)).release()
    other.kill()
  })

  it('refuses while another live host holds the folder, saying which', async () => {
    const dir = home()
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(
      path.join(dir, 'host.lock'),
      JSON.stringify({ pid: other.pid, port: 3773, startedAt: Date.now() }),
    )
    await expect(acquireHostLock(dir, 2, { waitMs: 300 })).rejects.toThrow(
      new RegExp(
        `Another BeddCode host \\(process ${other.pid}, port 3773\\).*different BEDDCODE_HOME`,
      ),
    )
    // Once it stops, the folder is free.
    const freed = acquireHostLock(dir, 2, { waitMs: 5_000 })
    other.kill()
    ;(await freed).release()
  })
})

describe('listenError', () => {
  it('says a port is taken, and how to pick another', async () => {
    const taken = net.createServer()
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r))
    const port = (taken.address() as net.AddressInfo).port
    const second = net.createServer()
    const err = await new Promise((r) => second.once('error', r).listen(port, '127.0.0.1'))
    taken.close()
    expect(String(listenError(err, '127.0.0.1', port))).toMatch(
      new RegExp(`Port ${port} on 127.0.0.1 is already in use.*--port`),
    )
    const other = new Error('x')
    expect(listenError(other, 'h', 1)).toBe(other)
  })
})
