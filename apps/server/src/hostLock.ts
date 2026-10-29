import { readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { isSameProcess, type Logger } from '@beddcode/shared'

interface LockInfo {
  pid: number
  port: number
  /** When the holding process started (ms since epoch), to tell it from a later one with its id. */
  startedAt: number
}

export interface HostLock {
  readonly file: string
  release(): void
}

const processStartedAt = () => Date.now() - process.uptime() * 1_000

/**
 * Makes sure only one host at a time uses a data folder. Two would both write the event log,
 * hand out the same session ids, and stop each other's agents. A lock left by a host that was
 * killed (its process is gone, or the id now belongs to another program) is taken over. A live
 * holder gets `waitMs` to finish stopping, which covers a restart where the old host is still
 * shutting down.
 */
export async function acquireHostLock(
  home: string,
  port: number,
  options: { log?: Pick<Logger, 'info' | 'warn'>; waitMs?: number } = {},
): Promise<HostLock> {
  mkdirSync(home, { recursive: true })
  const file = path.join(home, 'host.lock')
  const mine: LockInfo = { pid: process.pid, port, startedAt: processStartedAt() }
  const deadline = Date.now() + (options.waitMs ?? 10_000)
  let waiting = false
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: 'wx' })
      const lock: HostLock = {
        file,
        release() {
          try {
            const held = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>
            if (held.pid === process.pid) unlinkSync(file)
          } catch {
            // gone already, or not ours
          }
        },
      }
      return lock
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const held = readLock(file)
    const alive =
      held !== undefined &&
      held.pid !== process.pid &&
      // When its start time cannot be read, a live pid counts as the host unless it now runs a
      // program a host never is (Windows hands ids out again quickly): never run two at once.
      (await isSameProcess(held.pid, held.startedAt, undefined, { ifUnknown: couldBeHost }))
    if (!alive) {
      options.log?.info(
        held
          ? `taking over the lock of a host that is gone (process ${held.pid})`
          : 'replacing an unreadable host lock',
      )
      try {
        unlinkSync(file)
      } catch {
        // another host just took it over; the next attempt finds out
      }
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Another BeddCode host (process ${held.pid}, port ${held.port}) is already running with the data folder ${home}. ` +
          'Stop it first, or start this one with a different BEDDCODE_HOME.',
      )
    }
    if (!waiting) {
      waiting = true
      options.log?.info(`waiting for the host already using ${home} (process ${held.pid}) to stop`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

function readLock(file: string): LockInfo | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>
    if (typeof value.pid !== 'number' || typeof value.startedAt !== 'number') return undefined
    return { pid: value.pid, startedAt: value.startedAt, port: Number(value.port) || 0 }
  } catch {
    return undefined
  }
}

/** What to tell the user when the host cannot listen on its port. */
export function listenError(err: unknown, host: string, port: number): unknown {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') {
    return new Error(
      `Port ${port} on ${host} is already in use, by another BeddCode host or another program. ` +
        'Stop that program, or start BeddCode on another port with --port <number>.',
      { cause: err },
    )
  }
  if (code === 'EACCES') {
    return new Error(
      `BeddCode is not allowed to listen on port ${port} on ${host}. Use a port above 1024 with --port <number>.`,
      { cause: err },
    )
  }
  if (code === 'EADDRNOTAVAIL') {
    return new Error(
      `${host} is not an address of this computer (any more?), so BeddCode cannot listen on it. Check --host.`,
      { cause: err },
    )
  }
  return err
}

/** Program names a host can run as: node, Electron or the packaged app. Unknown counts as one. */
function couldBeHost(program: string): boolean {
  return program === '' || /node|electron|beddcode/i.test(program)
}
