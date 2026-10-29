import { spawn, type ChildProcess } from 'node:child_process'
import { spawnProcess } from '@beddcode/shared'
import type { AgentCommand, AgentTerminalHost } from '@beddcode/provider-core'

export interface CreateTerminal {
  command: string
  args?: string[]
  env?: { name: string; value: string }[]
  cwd?: string | null
  outputByteLimit?: number | null
}

export interface ExitStatus {
  exitCode?: number | null
  signal?: string | null
}

interface Terminal {
  child: ChildProcess
  output: string
  truncated: boolean
  limit: number | null
  exit: ExitStatus | null
  waiters: ((s: ExitStatus) => void)[]
}

const isWindows = process.platform === 'win32'

/**
 * Terminals an ACP agent asks us to run. With a host (the BeddCode server) they run in the
 * session's agent terminal, a pty the user watches; otherwise as plain child processes.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>()
  private readonly hosted = new Map<string, AgentCommand>()
  private nextId = 1

  constructor(
    private readonly defaultCwd: string,
    private readonly host?: AgentTerminalHost,
  ) {}

  create(req: CreateTerminal): { terminalId: string } {
    if (this.host) {
      const id = `term-${this.nextId++}`
      this.hosted.set(
        id,
        this.host.run({
          command: req.command,
          args: req.args,
          env: Object.fromEntries((req.env ?? []).map((e) => [e.name, e.value])),
          cwd: req.cwd ?? this.defaultCwd,
          outputByteLimit: req.outputByteLimit,
        }),
      )
      return { terminalId: id }
    }
    const env = {
      ...process.env,
      ...Object.fromEntries((req.env ?? []).map((e) => [e.name, e.value])),
    }
    const cwd = req.cwd ?? this.defaultCwd
    const args = req.args ?? []

    // Some agents pass a whole shell line as `command`; run those through the platform shell.
    const shellLine = args.length === 0 && /\s/.test(req.command)
    const child = shellLine
      ? isWindows
        ? spawn('cmd.exe', ['/d', '/s', '/c', req.command], {
            cwd,
            env,
            windowsHide: true,
            windowsVerbatimArguments: true,
          })
        : spawn('sh', ['-c', req.command], { cwd, env })
      : spawnProcess(req.command, args, { cwd, env })

    const id = `term-${this.nextId++}`
    const term: Terminal = {
      child,
      output: '',
      truncated: false,
      limit: req.outputByteLimit ?? null,
      exit: null,
      waiters: [],
    }
    const append = (chunk: Buffer) => {
      term.output += chunk.toString('utf8')
      if (term.limit !== null && Buffer.byteLength(term.output) > term.limit) {
        // Keep the tail: the end of the output is what an agent needs most.
        term.output = Buffer.from(term.output).subarray(-term.limit).toString('utf8')
        term.truncated = true
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const finish = (status: ExitStatus) => {
      if (term.exit) return
      term.exit = status
      for (const w of term.waiters.splice(0)) w(status)
    }
    child.on('error', (err) => {
      append(Buffer.from(`${err.message}\n`))
      finish({ exitCode: 127, signal: null })
    })
    child.on('close', (code, signal) => finish({ exitCode: code, signal }))

    this.terminals.set(id, term)
    return { terminalId: id }
  }

  output(id: string) {
    const hosted = this.hosted.get(id)
    if (hosted) return hosted.output()
    const t = this.get(id)
    return { output: t.output, truncated: t.truncated, exitStatus: t.exit }
  }

  waitForExit(id: string): Promise<ExitStatus> {
    const hosted = this.hosted.get(id)
    if (hosted) return hosted.waitForExit()
    const t = this.get(id)
    if (t.exit) return Promise.resolve(t.exit)
    return new Promise((resolve) => t.waiters.push(resolve))
  }

  kill(id: string) {
    const hosted = this.hosted.get(id)
    if (hosted) return hosted.kill()
    const t = this.get(id)
    if (!t.exit) killTree(t.child)
  }

  release(id: string) {
    const hosted = this.hosted.get(id)
    if (hosted) {
      this.hosted.delete(id)
      return hosted.release()
    }
    const t = this.terminals.get(id)
    if (!t) return
    if (!t.exit) killTree(t.child)
    this.terminals.delete(id)
  }

  releaseAll() {
    // Deleting the current entry while iterating a Map is safe.
    for (const id of [...this.terminals.keys(), ...this.hosted.keys()]) this.release(id)
  }

  private get(id: string): Terminal {
    const t = this.terminals.get(id)
    if (!t) throw new Error(`Unknown terminal: ${id}`)
    return t
  }
}

function killTree(child: ChildProcess) {
  if (child.pid === undefined) return
  if (isWindows) {
    // `child.kill()` would leave grandchildren (shells, dev servers) running.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  } else {
    child.kill('SIGTERM')
  }
}
