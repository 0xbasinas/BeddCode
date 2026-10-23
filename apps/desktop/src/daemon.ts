import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

/**
 * Where the local host is, as the app sees it:
 * - `starting`: launching it, waiting for it to answer,
 * - `running`: it answers, and the app started it (so the app also stops it),
 * - `attached`: one was already running (a terminal, a service); the app uses it and leaves it alone,
 * - `restarting`: it stopped on its own and is being started again,
 * - `failed`: it keeps stopping; the app tries once a minute from then on, or when asked,
 * - `stopped`: the app is closing it, or was never asked to start.
 */
export type DaemonStatus = 'starting' | 'running' | 'attached' | 'restarting' | 'failed' | 'stopped'

export interface DaemonState {
  status: DaemonStatus
  /** Why it failed, when it did: the last thing the host said. */
  detail?: string
  restarts: number
  logFile?: string
}

export interface LaunchSpec {
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

/** What the supervisor needs from a child process; a real one is adapted from `ChildProcess`. */
export interface HostProcess {
  pid?: number
  /** Resolves once the process has ended, with its exit code (null when killed by a signal). */
  exited: Promise<number | null>
  /** Asks it to stop. */
  kill(): void
  /** Makes it stop, for one that did not after being asked. */
  forceKill?(): void
}

export interface DaemonOptions {
  launch: LaunchSpec
  /** True when a host answers on the port. */
  probe(): Promise<boolean>
  /** Starts the process; replaced in tests. */
  spawnHost?(spec: LaunchSpec, log: (line: string) => void): HostProcess
  logFile?: string
  sleep?(ms: number): Promise<void>
  now?(): number
  /** How long a stopping host gets before it is killed outright. */
  stopGraceMs?: number
  /** How long to wait between tries once it has failed. */
  failedRetryMs?: number
}

const POLL_MS = 250
const START_TIMEOUT_MS = 30_000
const ATTACHED_POLL_MS = 2_000
const ATTACHED_MISSES = 3
/** A host that stays up this long has settled; its earlier crashes no longer count. */
const STABLE_MS = 20_000
const MAX_FAILURES = 5
/** After giving up, try again this often: a machine waking up or a port coming free fixes many. */
const FAILED_RETRY_MS = 60_000
const STOP_GRACE_MS = 5_000
const MAX_LOG_BYTES = 1_000_000

/** 1 s, 2 s, 4 s, 8 s, then 15 s between attempts. */
export const backoff = (failures: number) => Math.min(15_000, 1000 * 2 ** Math.max(0, failures - 1))

/**
 * Keeps the local host running for the desktop app: finds it if it is already up, otherwise starts
 * it, restarts it when it stops, and shuts it down with the app. Nothing here kills by name; it
 * only ever stops the process it started.
 */
export class Daemon {
  private state: DaemonState = { status: 'stopped', restarts: 0 }
  private readonly listeners = new Set<(state: DaemonState) => void>()
  private wanted = false
  private loop: Promise<void> | null = null
  private child: HostProcess | null = null
  /** Ends the wait in progress, so stopping does not sit out a back-off. */
  private wake: (() => void) | null = null
  /** The user asked for a restart: the next start is not a failure and needs no back-off. */
  private requested = false
  /** The user asked to retry while it had failed. */
  private retryNow = false
  private readonly tail: string[] = []
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly options: DaemonOptions) {
    this.now = options.now ?? Date.now
    const sleep =
      options.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms).unref?.()
        }))
    // Any wait can be cut short by `wake`.
    this.sleep = (ms) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          if (this.wake === finish) this.wake = null
          resolve()
        }
        this.wake = finish
        void sleep(ms).then(finish)
      })
    this.state.logFile = options.logFile
  }

  get current(): DaemonState {
    return this.state
  }

  onChange(listener: (state: DaemonState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Starts keeping the host up. Returns at once; follow progress with `onChange`. */
  start() {
    if (this.wanted) return
    this.wanted = true
    this.loop = this.supervise().finally(() => {
      this.loop = null
    })
  }

  /** Stops the host this app started, and waits for it to be gone. A host it only found stays up. */
  async stop() {
    this.wanted = false
    this.wake?.()
    if (this.child) this.terminate(this.child)
    await this.loop
    this.set({ status: 'stopped' })
  }

  /** Asks a child to stop, and kills it outright if it is still there after the grace period. */
  private terminate(child: HostProcess) {
    child.kill()
    if (!child.forceKill) return
    let done = false
    void child.exited.then(() => (done = true))
    const timer = setTimeout(() => {
      if (!done) child.forceKill?.()
    }, this.options.stopGraceMs ?? STOP_GRACE_MS)
    timer.unref?.()
    void child.exited.then(() => clearTimeout(timer))
  }

  /**
   * Replaces the host this app started, or starts a new one after a failure. A host the app only
   * found is left alone; false says so.
   */
  async restart(): Promise<boolean> {
    if (this.state.status === 'attached') return false
    if (this.wanted && this.child) {
      this.requested = true
      this.terminate(this.child)
      return true
    }
    if (this.wanted && this.state.status === 'failed') {
      this.retryNow = true
      this.wake?.()
      return true
    }
    await this.loop
    this.wanted = false
    this.state = { ...this.state, restarts: 0, detail: undefined }
    this.start()
    return true
  }

  private set(next: Partial<DaemonState> & { status: DaemonStatus }) {
    this.state = { ...this.state, detail: undefined, ...next }
    for (const listener of this.listeners) listener(this.state)
  }

  private async supervise() {
    let failures = 0
    while (this.wanted) {
      if (await this.options.probe()) {
        // Someone else runs a host here: use it, and take over if it goes away.
        this.set({ status: 'attached' })
        let misses = 0
        while (this.wanted && misses < ATTACHED_MISSES) {
          await this.sleep(ATTACHED_POLL_MS)
          misses = (await this.options.probe()) ? 0 : misses + 1
        }
        continue
      }

      this.set({ status: failures > 0 ? 'restarting' : 'starting' })
      const startedAt = this.now()
      this.tail.length = 0
      const child = (this.options.spawnHost ?? this.spawnReal)(this.options.launch, (line) => {
        this.tail.push(line)
        if (this.tail.length > 20) this.tail.shift()
      })
      this.child = child
      const exited = child.exited.then((code) => ({ code }))

      // Ready when it answers; not ready when it ends first, or takes too long.
      const deadline = this.now() + START_TIMEOUT_MS
      let ready = false
      for (;;) {
        const early = await Promise.race([exited, this.sleep(POLL_MS).then(() => null)])
        if (early) break
        if (await this.options.probe()) {
          ready = true
          break
        }
        if (this.now() > deadline) {
          this.terminate(child)
          break
        }
      }
      if (ready) this.set({ status: 'running' })

      const { code } = await exited
      this.child = null
      if (!this.wanted) return

      if (this.requested) {
        this.requested = false
        failures = 0
        continue
      }
      failures = this.now() - startedAt > STABLE_MS ? 1 : failures + 1
      const detail = this.tail.filter(Boolean).slice(-3).join('\n') || `exited with code ${code}`
      if (failures > MAX_FAILURES) {
        // Not for good: a host that fails on a cold boot or a busy port often starts later.
        this.set({ status: 'failed', detail, restarts: this.state.restarts })
        this.retryNow = false
        await this.sleep(this.options.failedRetryMs ?? FAILED_RETRY_MS)
        if (this.retryNow) {
          this.retryNow = false
          failures = 0
          this.state = { ...this.state, restarts: 0 }
        } else {
          // One try per wait from here, until it stays up.
          failures = MAX_FAILURES
        }
        continue
      }
      this.set({ status: 'restarting', detail, restarts: this.state.restarts + 1 })
      await this.sleep(backoff(failures))
    }
  }

  private readonly spawnReal = (spec: LaunchSpec, log: (line: string) => void): HostProcess =>
    spawnHost(spec, log, this.options.logFile)
}

/** Starts the host as a child process, writing what it says to the log file. */
export function spawnHost(
  spec: LaunchSpec,
  log: (line: string) => void,
  logFile?: string,
): HostProcess {
  let fd: number | undefined
  if (logFile) {
    mkdirSync(path.dirname(logFile), { recursive: true })
    // One file, started over when it gets large: the host's own history is in its database.
    try {
      if (statSync(logFile).size > MAX_LOG_BYTES) truncateSync(logFile, 0)
    } catch {
      // no file yet
    }
    fd = openSync(logFile, 'a')
  }
  const child: ChildProcess = nodeSpawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Its own process group on Unix, so the whole tree can be stopped.
    detached: process.platform !== 'win32',
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (err) => {
      log(String(err))
      resolve(null)
    })
    child.once('close', (code) => {
      if (fd !== undefined) closeSync(fd)
      resolve(code)
    })
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (fd !== undefined) {
        try {
          // Small and rare; the host is quiet unless something is wrong.
          writeSync(fd, text)
        } catch {
          // the log is a convenience
        }
      }
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(line.trim())
    })
  }
  return {
    pid: child.pid,
    exited,
    kill: () => killTree(child),
    forceKill: () => killTree(child, 'SIGKILL'),
  }
}

/** Stops a child and anything it started. */
export function killTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => child.kill())
  } else {
    try {
      process.kill(-child.pid, signal)
    } catch {
      child.kill(signal)
    }
  }
}

/** The last lines of the log, for showing why the host would not stay up. */
export function readLogTail(file: string, lines = 30): string {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n')
  } catch {
    return ''
  }
}

/** True when a host answers `/health` on the port. */
export async function probeHealth(port: number, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { ok?: boolean }
    return body.ok === true
  } catch {
    return false
  }
}
