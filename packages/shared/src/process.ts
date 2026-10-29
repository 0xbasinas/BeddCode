import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Logger } from './log.ts'
import { readJsonFile, writeFileAtomic } from './fsSafe.ts'

const isWindows = process.platform === 'win32'

/**
 * Finds an executable on PATH. On Windows tries each PATHEXT extension, since `claude` is
 * usually `claude.exe` and npm-installed CLIs are `.cmd` shims.
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return isFile(name) ? name : null
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  // On Windows an extensionless file (npm's `npx`, `codex` shell shims) is not runnable; only a
  // PATHEXT match is. The bare name counts only when it already carries such an extension.
  const pathExts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
  const exts = isWindows
    ? pathExts.some((e) => name.toLowerCase().endsWith(e))
      ? ['']
      : pathExts
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  cwd?: string
}

/**
 * Runs a short-lived command and collects its output. Never rejects for a non-zero exit;
 * rejects only when the process cannot be started or times out.
 * Windows `.cmd`/`.bat` shims go through cmd.exe because they cannot be exec'd directly.
 */
export function runCommand(
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const viaShell = isWindows && /\.(cmd|bat)$/i.test(file)
  return new Promise((resolve, reject) => {
    const child = execFile(
      viaShell ? 'cmd.exe' : file,
      viaShell ? ['/d', '/s', '/c', quoteForCmd(file), ...args.map(quoteForCmd)] : args,
      {
        timeout: options.timeoutMs ?? 10_000,
        env: options.env,
        cwd: options.cwd,
        windowsHide: true,
        windowsVerbatimArguments: viaShell,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && 'killed' in error && error.killed)
          return reject(new Error(`${file} timed out`))
        if (error && typeof error.code !== 'number') return reject(error)
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr })
      },
    )
    // Nothing is ever written to it. Left open, some programs wait on it: PowerShell never
    // exits (nodejs/node#25645), and git could sit at a prompt.
    child.stdin?.end()
  })
}

function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

export interface SpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Starts a long-running child with piped stdio. Windows `.cmd`/`.bat` shims go through cmd.exe,
 * everything else is executed directly (no shell, so arguments are never re-interpreted).
 */
export function spawnProcess(
  file: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcessWithoutNullStreams {
  const viaShell = isWindows && /\.(cmd|bat)$/i.test(file)
  const child = spawn(
    viaShell ? 'cmd.exe' : file,
    viaShell ? ['/d', '/s', '/c', quoteForCmd(file), ...args.map(quoteForCmd)] : args,
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: viaShell,
    },
  )
  track(child, viaShell ? 'cmd.exe' : file)
  return child
}

/** Long-running children still alive, so the host can make sure none outlives it. */
const running = new Set<ChildProcess>()

/** What the ledger keeps about a child, to find it again after the host itself was killed. */
export interface ChildRecord {
  pid: number
  /** The file that was executed (cmd.exe for a Windows shim). */
  command: string
  startedAt: number
  /** The process that started it. */
  owner: number
}
const records = new Map<ChildProcess, ChildRecord>()
let ledger: string | undefined

/**
 * Keeps a list of running children in `file` from now on. A host that is killed outright (kill -9,
 * Task Manager, a crash of Node itself) runs none of its exit handlers, so its agents would keep
 * running; the next host start reads this list and ends them (see `reapOrphans`).
 */
export function recordChildrenIn(file: string | undefined) {
  ledger = file
  saveLedger()
}

function saveLedger() {
  if (!ledger) return
  try {
    writeFileAtomic(ledger, JSON.stringify([...records.values()]))
  } catch {
    // Best effort: a full disk must not stop an agent from starting.
  }
}

/** Registers a long-running child started elsewhere (Claude's SDK spawns its own). */
export function trackChild(child: ChildProcess, command: string) {
  track(child, command)
}

function track(child: ChildProcess, command: string) {
  running.add(child)
  if (child.pid !== undefined) {
    records.set(child, { pid: child.pid, command, startedAt: Date.now(), owner: process.pid })
    saveLedger()
  }
  const forget = () => {
    running.delete(child)
    if (records.delete(child)) saveLedger()
  }
  child.once('exit', forget)
  child.once('error', forget)
}

/** How many children started with `spawnProcess` are still running. */
export function runningChildren(): number {
  return running.size
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

/**
 * Kills a child and, on Windows, everything it started. There `child.kill()` ends only the direct
 * process, which for an npm-installed agent is the `cmd.exe` running its `.cmd` shim: the real
 * agent (and anything it ran) would be left running. `taskkill /T` ends the whole tree.
 */
export function killProcessTree(child: ChildProcess, options: { sync?: boolean } = {}) {
  if (exited(child) || child.pid === undefined) return
  if (isWindows) {
    const args = ['/pid', String(child.pid), '/T', '/F']
    try {
      if (options.sync) spawnSync('taskkill', args, { windowsHide: true, timeout: 5_000 })
      else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
    } catch {
      // Fall back to the direct child at least.
    }
    try {
      child.kill()
    } catch {
      // already gone
    }
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
}

/**
 * Asks a child to stop and makes sure it does. Closing its stdin is the polite request (agents
 * on stdio exit when their input ends) and gives it a moment to save its own state: killing an
 * agent mid-write can leave its conversation file unreadable, so the next resume fails. Then
 * SIGTERM (after up to a second), and after `graceMs` a hard kill of the whole tree.
 */
export function stopProcess(
  child: ChildProcess,
  options: { graceMs?: number } = {},
): Promise<void> {
  if (exited(child) || child.pid === undefined) return Promise.resolve()
  const graceMs = options.graceMs ?? 3_000
  return new Promise((resolve) => {
    let hard: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      if (hard) clearTimeout(hard)
      resolve()
    }
    child.once('exit', done)
    try {
      child.stdin?.end()
    } catch {
      // a broken pipe is fine: the process is going away
    }
    // Then SIGTERM, for a child that does not watch its input. Not on Windows: there a signal is a
    // hard kill of the shim only, so stdin EOF and then the tree kill are all there is.
    const term = isWindows
      ? undefined
      : setTimeout(
          () => {
            try {
              child.kill('SIGTERM')
            } catch {
              // already gone
            }
          },
          Math.min(1_000, graceMs / 3),
        )
    term?.unref?.()
    child.once('exit', () => term && clearTimeout(term))
    hard = setTimeout(() => {
      killProcessTree(child)
      // Whatever happens next, do not keep the caller waiting on a process that will not report.
      setTimeout(resolve, 1_000).unref?.()
    }, graceMs)
    hard.unref?.()
  })
}

/**
 * Last resort when the host is exiting: kills every child still running, synchronously, so no
 * agent is left orphaned (on Windows, children are not ended with their parent).
 */
export function killAllChildren() {
  for (const child of Array.from(running)) killProcessTree(child, { sync: true })
  running.clear()
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in seconds. */
function parseElapsed(text: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim())
  if (!m) return undefined
  const [, d = '0', h = '0', min = '0', sec = '0'] = m
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec)
}

type ProcessFacts = { startedAt: number; command: string }

/**
 * When each process started and what it runs, in one look-up. A pid missing from the map is not
 * running. Undefined when the system could not be asked (e.g. PowerShell too slow to start), which
 * callers must treat as "cannot tell", not as "gone".
 */
export async function processInfos(
  pids: readonly number[],
): Promise<Map<number, ProcessFacts> | undefined> {
  const found = new Map<number, ProcessFacts>()
  const ids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0)
  if (ids.length === 0) return found
  try {
    if (isWindows) {
      // One PowerShell for every pid: it can take seconds to start on a busy machine.
      const res = await runCommand(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-InputFormat',
          'None',
          '-Command',
          `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}|{2}' -f $_.Id, $_.StartTime.ToUniversalTime().ToString('o'), $_.Path }`,
        ],
        { timeoutMs: 30_000 },
      )
      for (const line of res.stdout.split(/\r?\n/)) {
        const [id = '', when = '', ...command] = line.trim().split('|')
        const startedAt = Date.parse(when)
        if (/^\d+$/.test(id) && Number.isFinite(startedAt))
          found.set(Number(id), { startedAt, command: command.join('|') })
      }
      // Get-Process exits non-zero when some pid is gone; only output that says nothing at all
      // while it failed means PowerShell itself did not work.
      if (found.size === 0 && res.code !== 0 && !/cannot find a process/i.test(res.stderr)) {
        return ids.some(isAlive) ? undefined : found
      }
      return found
    }
    const res = await runCommand('ps', ['-o', 'pid=,etime=,command=', '-p', ids.join(',')], {
      timeoutMs: 10_000,
    })
    for (const line of res.stdout.split('\n')) {
      const [id = '', elapsed = '', ...rest] = line.trim().split(/\s+/)
      const seconds = parseElapsed(elapsed)
      if (!/^\d+$/.test(id) || seconds === undefined) continue
      found.set(Number(id), { startedAt: Date.now() - seconds * 1_000, command: rest.join(' ') })
    }
    return found
  } catch {
    return undefined
  }
}

/** When a process started and what it runs, or undefined when that cannot be told. */
export async function processInfo(pid: number): Promise<ProcessFacts | undefined> {
  return (await processInfos([pid]))?.get(pid)
}

function matches(info: ProcessFacts, startedAt: number, command?: string): boolean {
  // `ps` reports whole seconds; allow for that and for a slow spawn.
  if (Math.abs(info.startedAt - startedAt) > 15_000) return false
  if (!command) return true
  const name = path
    .basename(command)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '')
  return info.command.toLowerCase().includes(name)
}

/**
 * True when `pid` is still the process described: alive, started within a few seconds of the
 * recorded time, and running the recorded program. Process ids are reused, so an id alone could
 * name some unrelated program by now. When the system cannot be asked, `ifUnknown` is returned
 * for a pid that is alive (default false: never act on a process that cannot be identified).
 */
export async function isSameProcess(
  pid: number,
  startedAt: number,
  command?: string,
  options: { ifUnknown?: boolean } = {},
): Promise<boolean> {
  if (!isAlive(pid)) return false
  const infos = await processInfos([pid])
  if (!infos) return options.ifUnknown ?? false
  const info = infos.get(pid)
  return info !== undefined && matches(info, startedAt, command)
}

/** Every process below `pid`, deepest first (POSIX; on Windows taskkill /T does this itself). */
async function descendantsOf(pid: number): Promise<number[]> {
  const found: number[] = []
  const walk = async (parent: number, depth: number) => {
    if (depth > 8) return
    const res = await runCommand('pgrep', ['-P', String(parent)], { timeoutMs: 3_000 }).catch(
      () => undefined,
    )
    for (const child of (res?.stdout ?? '').split(/\s+/).filter(Boolean).map(Number)) {
      await walk(child, depth + 1)
      found.push(child)
    }
  }
  await walk(pid, 0)
  return found
}

/**
 * Ends the agents a previous host recorded (see `recordChildrenIn`) that are still running because
 * that host was killed before it could stop them. Only processes that are provably the recorded
 * ones are touched, and none whose host is still alive. Returns how many were ended.
 */
export async function reapOrphans(file: string, log?: Logger): Promise<number> {
  const read = readJsonFile<ChildRecord[]>(file)
  if (read.status !== 'ok' || !Array.isArray(read.value)) return 0
  const candidates = read.value.filter(
    (rec) =>
      typeof rec?.pid === 'number' &&
      typeof rec.startedAt === 'number' &&
      rec.owner !== process.pid &&
      !(typeof rec.owner === 'number' && isAlive(rec.owner)),
  )
  if (candidates.length === 0) return 0
  // Looked up together: on Windows each look-up starts PowerShell, which can take seconds.
  const infos = await processInfos(candidates.map((rec) => rec.pid))
  if (!infos) {
    log?.warn('could not check whether agents a previous host started are still running')
    return 0
  }
  let ended = 0
  for (const rec of candidates) {
    const info = infos.get(rec.pid)
    if (!info || !isAlive(rec.pid) || !matches(info, rec.startedAt, rec.command)) continue
    try {
      if (isWindows) {
        await runCommand('taskkill', ['/pid', String(rec.pid), '/T', '/F'], { timeoutMs: 10_000 })
      } else {
        for (const pid of [...(await descendantsOf(rec.pid)), rec.pid]) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // already gone
          }
        }
      }
      ended++
      log?.warn(
        `ended ${path.basename(rec.command)} (pid ${rec.pid}), left running by a host that was killed`,
      )
    } catch (err) {
      log?.warn(`could not end leftover process ${rec.pid}`, err)
    }
  }
  return ended
}
