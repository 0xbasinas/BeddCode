import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

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
    execFile(
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
  track(child)
  return child
}

/** Long-running children still alive, so the host can make sure none outlives it. */
const running = new Set<ChildProcess>()

function track(child: ChildProcess) {
  running.add(child)
  const forget = () => running.delete(child)
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
