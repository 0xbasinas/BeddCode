import { randomUUID } from 'node:crypto'
import path from 'node:path'
import * as nodePty from '@lydell/node-pty'
import type { TerminalInfo } from '@beddcode/contracts'
import { resolveExecutable } from '@beddcode/shared'

export interface PtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void
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
/** Ended terminals kept for their output; past this the oldest ones are forgotten. */
const MAX_EXITED = 10

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
  exitedAt?: number
}

export interface AgentTerminalParams {
  cwd: string
  sessionId: string
  /** The agent's name, e.g. `Grok`. */
  label: string
  instanceId?: string
  /** The session's title, for the tab. */
  sessionTitle?: string
  mode: 'pty' | 'mirror'
}

/**
 * An agent terminal has no shell of its own. It shows what the agent runs: the output of each
 * command is fed in, and while a command runs in a pty of ours, typing (once the user has taken
 * the terminal over), resizing and backpressure go to that command.
 */
class AgentChannel implements PtyProcess {
  readonly pid = 0
  /** The agent's commands running now, each in a pty of its own. */
  readonly children = new Set<PtyProcess>()
  /** The one typing goes to: the command shown in the terminal now. */
  focus: PtyProcess | null = null
  constructor(
    public cols: number,
    public rows: number,
  ) {}
  onData() {}
  onExit() {}
  write(data: string) {
    this.focus?.write(data)
  }
  resize(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    for (const c of this.children) {
      try {
        c.resize(cols, rows)
      } catch {
        // the command just ended
      }
    }
  }
  kill() {
    for (const c of this.children) {
      try {
        c.kill()
      } catch {
        // already gone
      }
    }
  }
  pause() {
    for (const c of this.children) c.pause()
  }
  resume() {
    for (const c of this.children) c.resume()
  }
}

/**
 * Shells that live on the host. Output is batched, kept in a bounded buffer for late attachers,
 * and the shell is paused when a client cannot keep up, so a runaway command cannot flood a
 * slow connection.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>()
  private readonly changeListeners = new Set<
    (change: { cwd: string; id: string; terminal: TerminalInfo | null }) => void
  >()

  constructor(
    private readonly options: {
      pty?: PtyFactory
      shell?: () => ShellSpec
      env?: NodeJS.ProcessEnv
      maxExited?: number
    } = {},
  ) {}

  create(params: {
    cwd: string
    cols?: number
    rows?: number
    shell?: ShellSpec
    /** Typed into the shell once it starts, as if the user had (a project script). */
    command?: string
    title?: string
    /** Running a project script again replaces its earlier terminal in the same folder. */
    scriptId?: string
  }): TerminalInfo {
    if (params.scriptId) {
      for (const t of this.terminals.values()) {
        if (t.info.scriptId === params.scriptId && sameFolder(t.info.cwd, params.cwd))
          this.close(t.info.id)
      }
    }
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
      info: {
        id,
        cwd: params.cwd,
        shell: shell.name,
        ...(params.title ? { title: params.title } : {}),
        ...(params.scriptId ? { scriptId: params.scriptId } : {}),
        cols,
        rows,
        createdAt: Date.now(),
      },
      pty,
      buffer: '',
      pending: '',
      timer: null,
      subscribers: new Set(),
      paused: false,
      poll: null,
    }
    this.terminals.set(id, term)
    this.changed(term)

    pty.onData((data) => this.onData(term, data))
    pty.onExit(({ exitCode }) => this.onExit(term, exitCode))
    // The shell reads it once it is ready, so it shows up in the terminal like typed input and the
    // shell stays open afterwards for the output and a rerun.
    if (params.command) pty.write(`${params.command.replace(/\r?\n/g, ' ')}\r`)
    return { ...term.info }
  }

  /** Called when a terminal appears, changes (an agent's command starts or ends) or goes away. */
  onChange(
    listener: (change: { cwd: string; id: string; terminal: TerminalInfo | null }) => void,
  ): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private changed(term: Terminal, gone = false) {
    const change = { cwd: term.info.cwd, id: term.info.id, terminal: gone ? null : snapshot(term) }
    for (const l of this.changeListeners) l(change)
  }

  /**
   * The session's agent terminal, opened on first use. It starts read-only: the agent's commands
   * show up in it, and the user can take it over to type into a running command.
   */
  agentTerminal(params: AgentTerminalParams): string {
    for (const t of this.terminals.values()) {
      if (t.info.agent?.sessionId === params.sessionId && t.info.exited === undefined)
        return t.info.id
    }
    const channel = new AgentChannel(100, 24)
    const id = randomUUID()
    const title = params.sessionTitle ? `${params.label} · ${params.sessionTitle}` : params.label
    const term: Terminal = {
      info: {
        id,
        cwd: params.cwd,
        shell: params.label,
        title: title.length > 40 ? `${title.slice(0, 39)}…` : title,
        agent: {
          sessionId: params.sessionId,
          label: params.label,
          mode: params.mode,
          ...(params.instanceId ? { instanceId: params.instanceId } : {}),
        },
        readOnly: true,
        cols: channel.cols,
        rows: channel.rows,
        createdAt: Date.now(),
      },
      pty: channel,
      buffer: '',
      pending: '',
      timer: null,
      subscribers: new Set(),
      paused: false,
      poll: null,
    }
    this.terminals.set(id, term)
    this.changed(term)
    return id
  }

  /** Shows output in an agent terminal. False when it is gone (the user closed it). */
  feed(id: string, data: string): boolean {
    const term = this.terminals.get(id)
    if (!term?.info.agent || term.info.exited !== undefined) return false
    if (data) this.onData(term, data)
    return true
  }

  /** Says which command an agent terminal is running (undefined: none). */
  setRunning(id: string, command: string | undefined) {
    const term = this.terminals.get(id)
    if (!term?.info.agent || term.info.agent.running === command) return
    if (command === undefined) delete term.info.agent.running
    else term.info.agent.running = command
    this.changed(term)
  }

  /**
   * Starts a command in a pty of its own, sized like the agent terminal `id`. Its output is the
   * caller's to show (with `feed`); typing reaches it while it has the focus (`focusAgentChild`).
   */
  spawnInAgentTerminal(
    id: string,
    file: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ): PtyProcess {
    const term = this.require(id)
    if (!(term.pty instanceof AgentChannel)) throw new Error('Not an agent terminal')
    const channel = term.pty
    const env = {
      ...(this.options.env ?? process.env),
      ...options.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as Record<string, string>
    const child = (this.options.pty ?? defaultPty)(file, args, {
      cwd: options.cwd,
      env,
      cols: channel.cols,
      rows: channel.rows,
    })
    channel.children.add(child)
    channel.focus ??= child
    child.onExit(() => {
      channel.children.delete(child)
      if (channel.focus === child) channel.focus = null
    })
    if (term.paused) child.pause()
    return child
  }

  /** Sends what the user types in agent terminal `id` to this command of its. */
  focusAgentChild(id: string, child: PtyProcess) {
    const channel = this.terminals.get(id)?.pty
    if (channel instanceof AgentChannel && channel.children.has(child)) channel.focus = child
  }

  /** The user types into an agent terminal from now on (into the command it is running). */
  takeOver(id: string): TerminalInfo {
    const term = this.require(id)
    if (term.info.readOnly) {
      delete term.info.readOnly
      this.changed(term)
    }
    return snapshot(term)
  }

  /** The session has ended: its agent terminal stays readable until it is closed or forgotten. */
  endAgentTerminal(id: string) {
    const term = this.terminals.get(id)
    if (!term?.info.agent || term.info.exited !== undefined) return
    term.pty.kill()
    this.onExit(term, 0)
  }

  has(id: string): boolean {
    return this.terminals.has(id)
  }

  list(cwd?: string): TerminalInfo[] {
    return [...this.terminals.values()]
      .filter((t) => cwd === undefined || sameFolder(t.info.cwd, cwd))
      .map(snapshot)
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
    if (term && term.info.exited === undefined && !term.info.readOnly) term.pty.write(data)
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
    this.changed(term, true)
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
    term.exitedAt = Date.now()
    for (const s of term.subscribers) s.send({ t: 'term.exit', id: term.info.id, code })
    this.changed(term)
    this.forgetOldExited()
  }

  /** Ended terminals pile up (every script run, every `exit`); keep only the latest few. */
  private forgetOldExited() {
    const max = this.options.maxExited ?? MAX_EXITED
    const ended = [...this.terminals.values()]
      .filter((t) => t.info.exited !== undefined)
      .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0))
    for (const t of ended.slice(0, Math.max(0, ended.length - max))) this.close(t.info.id)
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

/** A copy of a terminal's info that later changes to it do not reach. */
function snapshot(term: { info: TerminalInfo }): TerminalInfo {
  return term.info.agent ? { ...term.info, agent: { ...term.info.agent } } : { ...term.info }
}
