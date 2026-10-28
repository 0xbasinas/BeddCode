import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { spawnProcess } from '@beddcode/shared'

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
 * Terminals an ACP agent asks us to run. Plain child processes for now; phase 7 backs these with
 * the same pty terminals the UI shows.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>()
  private nextId = 1

  constructor(private readonly defaultCwd: string) {}

  create(req: CreateTerminal): { terminalId: string } {
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
    const add = (text: string) => {
      term.output += text
      if (term.limit !== null && Buffer.byteLength(term.output) > term.limit) {
        // Keep the tail: the end of the output is what an agent needs most.
        term.output = tailWithin(term.output, term.limit)
        term.truncated = true
      }
    }
    // A multi-byte character can arrive split across two chunks; a decoder per stream joins it.
    const follow = (stream: NodeJS.ReadableStream | null | undefined) => {
      if (!stream) return
      const decoder = new StringDecoder('utf8')
      stream.on('data', (chunk: Buffer) => add(decoder.write(chunk)))
      stream.on('end', () => add(decoder.end()))
    }
    const append = (chunk: Buffer) => add(chunk.toString('utf8'))
    follow(child.stdout)
    follow(child.stderr)
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
    const t = this.get(id)
    return { output: t.output, truncated: t.truncated, exitStatus: t.exit }
  }

  /** The output so far, or nothing when the terminal is unknown or already released. */
  peek(id: string): string | undefined {
    return this.terminals.get(id)?.output
  }

  waitForExit(id: string): Promise<ExitStatus> {
    const t = this.get(id)
    if (t.exit) return Promise.resolve(t.exit)
    return new Promise((resolve) => t.waiters.push(resolve))
  }

  kill(id: string) {
    const t = this.get(id)
    if (!t.exit) killTree(t.child)
  }

  release(id: string) {
    const t = this.terminals.get(id)
    if (!t) return
    if (!t.exit) killTree(t.child)
    this.terminals.delete(id)
  }

  releaseAll() {
    // Deleting the current entry while iterating a Map is safe.
    for (const id of this.terminals.keys()) this.release(id)
  }

  private get(id: string): Terminal {
    const t = this.terminals.get(id)
    if (!t) throw new Error(`Unknown terminal: ${id}`)
    return t
  }
}

/** The end of `text` that fits in `limit` bytes, cut at a character boundary as the protocol asks. */
export function tailWithin(text: string, limit: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= limit) return text
  let start = bytes.length - Math.max(0, limit)
  // Skip continuation bytes (10xxxxxx) so the cut never lands inside a character.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
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
