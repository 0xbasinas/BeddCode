import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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

export function quoteForCmd(arg: string): string {
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
  return spawn(
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
}
