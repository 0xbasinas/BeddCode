import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  isSameProcess,
  processInfos,
  reapOrphans,
  recordChildrenIn,
  spawnProcess,
  stopProcess,
  type ChildRecord,
} from './process.ts'

const node = process.execPath
const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-ledger-'))
afterAll(() => {
  recordChildrenIn(undefined)
  rmSync(dir, { recursive: true, force: true })
})

/** A pid that belonged to a process that has exited. */
const deadPid = () => spawnSync(node, ['-e', '0']).pid!

const sleeper = () => {
  const child = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const exited = new Promise((r) => child.once('exit', r))
  return { child, exited, startedAt: Date.now() }
}

/**
 * Whether this machine can tell when a process started. On Windows that takes PowerShell, which
 * on CI machines may not answer; then the checks must stay on the safe side instead.
 */
const startTimesReadable = async (pid: number) => {
  const readable = Number.isFinite((await processInfos([pid]))?.get(pid)?.startedAt ?? NaN)
  if (!readable) console.warn('process start times cannot be read here; checking the safe side')
  return readable
}

// On Windows every process check starts PowerShell, which is slow on CI machines.
describe('child ledger', { timeout: process.platform === 'win32' ? 60_000 : 5_000 }, () => {
  it('lists running children in the file, and drops them as they exit', async () => {
    const file = path.join(dir, 'children.json')
    recordChildrenIn(file)
    const child = spawnProcess(node, ['-e', 'setInterval(() => {}, 1000)'])
    const listed = JSON.parse(readFileSync(file, 'utf8')) as ChildRecord[]
    expect(listed).toContainEqual(
      expect.objectContaining({ pid: child.pid, command: node, owner: process.pid }),
    )
    await stopProcess(child, { graceMs: 500 })
    await new Promise((r) => setTimeout(r, 20))
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toContainEqual(
      expect.objectContaining({ pid: child.pid }),
    )
    recordChildrenIn(undefined)
  })

  it('ends what a killed host left running, and nothing else', async () => {
    const orphan = sleeper()
    const ownedByLiveHost = sleeper()
    const reusedPid = sleeper()
    await new Promise((r) => setTimeout(r, 100))
    const file = path.join(dir, 'left.json')
    const records: ChildRecord[] = [
      { pid: orphan.child.pid!, command: node, startedAt: orphan.startedAt, owner: deadPid() },
      // Its host is still running: not ours to end.
      {
        pid: ownedByLiveHost.child.pid!,
        command: node,
        startedAt: ownedByLiveHost.startedAt,
        owner: process.ppid,
      },
      // The id now names a process that started much later: some other program.
      {
        pid: reusedPid.child.pid!,
        command: node,
        startedAt: reusedPid.startedAt - 3_600_000,
        owner: deadPid(),
      },
      // A process long gone.
      { pid: deadPid(), command: node, startedAt: Date.now(), owner: deadPid() },
    ]
    writeFileSync(file, JSON.stringify(records))
    const warnings: string[] = []
    const log = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} }
    if (await startTimesReadable(orphan.child.pid!)) {
      expect(await reapOrphans(file, log)).toBe(1)
      await orphan.exited
      expect(warnings[0]).toMatch(/left running by a host that was killed/)
    } else {
      // Unidentifiable processes are never ended.
      expect(await reapOrphans(file, log)).toBe(0)
      expect(orphan.child.exitCode).toBeNull()
      orphan.child.kill()
    }
    expect(ownedByLiveHost.child.exitCode).toBeNull()
    expect(reusedPid.child.exitCode).toBeNull()
    ownedByLiveHost.child.kill()
    reusedPid.child.kill()
  })

  it('tells a process from another that later got its id', async () => {
    const { child, startedAt } = sleeper()
    await new Promise((r) => setTimeout(r, 100))
    if (!(await startTimesReadable(child.pid!))) {
      expect(await isSameProcess(child.pid!, startedAt, node)).toBe(false)
      const byName = { ifUnknown: (program: string) => /node/i.test(program) }
      expect(await isSameProcess(child.pid!, startedAt, node, byName)).toBe(true)
      child.kill()
      return
    }
    expect(await isSameProcess(child.pid!, startedAt, node)).toBe(true)
    expect(await isSameProcess(child.pid!, startedAt, '/usr/bin/some-other-agent')).toBe(false)
    expect(await isSameProcess(child.pid!, startedAt - 600_000, node)).toBe(false)
    child.kill()
  })

  it('looks up several processes at once, leaving out ones that are gone', async () => {
    const a = sleeper()
    const b = sleeper()
    const gone = deadPid()
    const infos = await processInfos([a.child.pid!, b.child.pid!, gone])
    expect(infos).toBeDefined()
    expect([...infos!.keys()].sort()).toEqual([a.child.pid!, b.child.pid!].sort())
    if (await startTimesReadable(a.child.pid!)) {
      expect(Math.abs(infos!.get(a.child.pid!)!.startedAt - a.startedAt)).toBeLessThan(15_000)
    }
    a.child.kill()
    b.child.kill()
  })

  it('reads a missing or damaged ledger as empty', async () => {
    expect(await reapOrphans(path.join(dir, 'none.json'))).toBe(0)
    const bad = path.join(dir, 'bad.json')
    writeFileSync(bad, '{"pid":')
    expect(await reapOrphans(bad)).toBe(0)
  })
})
