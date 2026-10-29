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
  /** Decoded output in arrival order, with each piece's size in bytes. */
  pieces: { text: string; bytes: number }[]
  bytes: number
  truncated: boolean
  limit: number | null
  exit: ExitStatus | null
  waiters: ((s: ExitStatus) => void)[]
}

const isWindows = process.platform === 'win32'

/**
 * Output kept when the agent sets no limit: a command that prints without end (a dev server, a
 * `yes`) must not grow the host's memory until it runs out.
 */
export const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024

/** The last `limit` bytes of `text`, starting on a whole character. */
export function tailBytes(text: string, limit: number): string {
  const buf = Buffer.from(text)
  if (buf.length <= limit) return text
  let start = buf.length - limit
  // Skip UTF-8 continuation bytes (10xxxxxx), so no character is cut in half.
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++
  return buf.subarray(start).toString('utf8')
}

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
      pieces: [],
      bytes: 0,
      truncated: false,
      limit: req.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT,
      exit: null,
      waiters: [],
    }
    const add = (text: string) => {
      if (!text) return
      const bytes = Buffer.byteLength(text)
      term.pieces.push({ text, bytes })
      term.bytes += bytes
      // Keep the tail: the end of the output is what an agent needs most. Whole pieces are
      // dropped here; `output` trims the first one to the exact limit.
      const limit = term.limit
      if (limit === null) return
      while (term.pieces.length > 1 && term.bytes - term.pieces[0]!.bytes >= limit) {
        term.bytes -= term.pieces.shift()!.bytes
        term.truncated = true
      }
    }
    // One decoder per stream: a character split across two chunks stays whole.
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const append = (chunk: Buffer) => add(chunk.toString('utf8'))
    child.stdout?.on('data', (chunk: Buffer) => add(decoders.stdout.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => add(decoders.stderr.write(chunk)))
    child.stdout?.on('end', () => add(decoders.stdout.end()))
    child.stderr?.on('end', () => add(decoders.stderr.end()))
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
    let output = t.pieces.map((p) => p.text).join('')
    let truncated = t.truncated
    if (t.limit !== null && t.bytes > t.limit) {
      output = tailBytes(output, t.limit)
      truncated = true
    }
    return { output, truncated, exitStatus: t.exit }
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
