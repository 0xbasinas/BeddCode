import { randomUUID } from 'node:crypto'
import path from 'node:path'
import * as nodePty from '@lydell/node-pty'
import type { TerminalInfo } from '@beddcode/contracts'
import { resolveExecutable } from '@beddcode/shared'

export interface PtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  pause(): void
  resume(): void
}

export interface PtyOptions {
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export type PtyFactory = (file: string, args: string[], options: PtyOptions) => PtyProcess

export interface ShellSpec {
  file: string
  args: string[]
  /** Label for the tab. */
  name: string
}

export type TerminalFrame =
  | { t: 'term.out'; id: string; data: string; replay?: boolean }
  | { t: 'term.exit'; id: string; code: number | null }

/** One connected client's view of a terminal. */
export interface TerminalSubscriber {
  send(frame: TerminalFrame): void
  /** Bytes queued for this client but not yet on the network; drives backpressure. */
  backlog(): number
}

const defaultPty: PtyFactory = (file, args, options) =>
  nodePty.spawn(file, args, {
    name: 'xterm-256color',
    cwd: options.cwd,
    env: options.env,
    cols: options.cols,
    rows: options.rows,
  }) as unknown as PtyProcess

/** Output kept for clients that attach later (or reconnect). */
const BUFFER_CHARS = 200_000
/** Output is sent in batches: at most this often, or sooner once a batch is this large. */
const FLUSH_MS = 8
const FLUSH_CHARS = 32_768
/** Stop reading from the shell when a client is this far behind; resume once it catches up. */
const HIGH_WATER = 1_000_000
const LOW_WATER = 256_000
const POLL_MS = 50

/** The shell a user would expect: PowerShell 7, then Windows PowerShell, else cmd; $SHELL elsewhere. */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  find: (name: string) => string | null = (n) => resolveExecutable(n),
): ShellSpec {
  if (platform === 'win32') {
    const ps = find('pwsh') ?? find('powershell')
    if (ps)
      return { file: ps, args: ['-NoLogo'], name: path.win32.basename(ps).replace(/\.exe$/i, '') }
    return { file: env.COMSPEC ?? 'cmd.exe', args: [], name: 'cmd' }
  }
  const file = env.SHELL && env.SHELL.length > 0 ? env.SHELL : (find('bash') ?? '/bin/sh')
  return { file, args: [], name: path.basename(file) }
}

interface Terminal {
  info: TerminalInfo
  pty: PtyProcess
  buffer: string
  pending: string
  timer: ReturnType<typeof setTimeout> | null
  subscribers: Set<TerminalSubscriber>
  paused: boolean
  poll: ReturnType<typeof setInterval> | null
}

/**
 * Shells that live on the host. Output is batched, kept in a bounded buffer for late attachers,
 * and the shell is paused when a client cannot keep up, so a runaway command cannot flood a
 * slow connection.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>()

  constructor(
    private readonly options: {
      pty?: PtyFactory
      shell?: () => ShellSpec
      env?: NodeJS.ProcessEnv
    } = {},
  ) {}

  create(params: { cwd: string; cols?: number; rows?: number; shell?: ShellSpec }): TerminalInfo {
    const shell = params.shell ?? (this.options.shell ?? defaultShell)()
    const cols = params.cols ?? 80
    const rows = params.rows ?? 24
    const env = {
      ...(this.options.env ?? process.env),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as Record<string, string>

    const pty = (this.options.pty ?? defaultPty)(shell.file, shell.args, {
      cwd: params.cwd,
      env,
      cols,
      rows,
    })
    const id = randomUUID()
    const term: Terminal = {
      info: { id, cwd: params.cwd, shell: shell.name, cols, rows, createdAt: Date.now() },
      pty,
      buffer: '',
      pending: '',
      timer: null,
      subscribers: new Set(),
      paused: false,
      poll: null,
    }
    this.terminals.set(id, term)

    pty.onData((data) => this.onData(term, data))
    pty.onExit(({ exitCode }) => this.onExit(term, exitCode))
    return { ...term.info }
  }

  list(cwd?: string): TerminalInfo[] {
    return [...this.terminals.values()]
      .filter((t) => cwd === undefined || sameFolder(t.info.cwd, cwd))
      .map((t) => ({ ...t.info }))
  }

  /** Sends the buffered history, then live output. Returns a function that detaches. */
  attach(id: string, subscriber: TerminalSubscriber): () => void {
    const term = this.require(id)
    // Current subscribers get what is waiting in the batch now; the new one receives it below as
    // part of the history, so nobody sees it twice or misses it.
    this.flush(term)
    if (term.buffer) subscriber.send({ t: 'term.out', id, data: term.buffer, replay: true })
    if (term.info.exited !== undefined) {
      subscriber.send({ t: 'term.exit', id, code: term.info.exited })
    }
    term.subscribers.add(subscriber)
    return () => term.subscribers.delete(subscriber)
  }

  write(id: string, data: string) {
    const term = this.terminals.get(id)
    if (term && term.info.exited === undefined) term.pty.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    const term = this.terminals.get(id)
    if (!term || term.info.exited !== undefined) return
    term.pty.resize(cols, rows)
    term.info.cols = cols
    term.info.rows = rows
  }

  /** Ends the shell if it is running and forgets the terminal. */
  close(id: string): boolean {
    const term = this.terminals.get(id)
    if (!term) return false
    this.terminals.delete(id)
    this.clearTimers(term)
    if (term.info.exited === undefined) {
      try {
        term.pty.kill()
      } catch {
        // already gone
      }
    }
    for (const s of term.subscribers) s.send({ t: 'term.exit', id, code: term.info.exited ?? null })
    term.subscribers.clear()
    return true
  }

  shutdown() {
    // Deleting the current entry while iterating a Map is safe.
    for (const id of this.terminals.keys()) this.close(id)
  }

  private require(id: string): Terminal {
    const term = this.terminals.get(id)
    if (!term) throw new Error(`Unknown terminal: ${id}`)
    return term
  }

  private onData(term: Terminal, data: string) {
    term.buffer += data
    if (term.buffer.length > BUFFER_CHARS) term.buffer = term.buffer.slice(-BUFFER_CHARS)
    term.pending += data
    if (term.pending.length >= FLUSH_CHARS) this.flush(term)
    else term.timer ??= setTimeout(() => this.flush(term), FLUSH_MS)
  }

  /** Sends the batch to subscribers, then applies backpressure. */
  private flush(term: Terminal) {
    if (term.timer) clearTimeout(term.timer)
    term.timer = null
    const data = term.pending
    term.pending = ''
    if (!data) return
    for (const s of term.subscribers) s.send({ t: 'term.out', id: term.info.id, data })
    this.applyBackpressure(term)
  }

  private applyBackpressure(term: Terminal) {
    if (term.paused || term.info.exited !== undefined) return
    const worst = Math.max(0, ...[...term.subscribers].map((s) => s.backlog()))
    if (worst <= HIGH_WATER) return
    term.paused = true
    term.pty.pause()
    term.poll = setInterval(() => {
      const behind = Math.max(0, ...[...term.subscribers].map((s) => s.backlog()))
      if (behind >= LOW_WATER && term.subscribers.size > 0) return
      term.paused = false
      if (term.poll) clearInterval(term.poll)
      term.poll = null
      term.pty.resume()
    }, POLL_MS)
  }

  private onExit(term: Terminal, code: number) {
    this.flush(term)
    this.clearTimers(term)
    term.info.exited = code
    for (const s of term.subscribers) s.send({ t: 'term.exit', id: term.info.id, code })
  }

  private clearTimers(term: Terminal) {
    if (term.timer) clearTimeout(term.timer)
    if (term.poll) clearInterval(term.poll)
    term.timer = null
    term.poll = null
  }
}

function sameFolder(a: string, b: string) {
  const norm = (p: string) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
  return norm(a) === norm(b)
}
