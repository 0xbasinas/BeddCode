import { randomUUID } from 'node:crypto'
import path from 'node:path'
import * as nodePty from '@lydell/node-pty'
import type { PreviewEntry, TerminalInfo } from '@beddcode/contracts'
import { resolveExecutable, type Logger } from '@beddcode/shared'
import { detectPreviewUrls, mergePreviews } from './previews.ts'

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
  | { t: 'term.out'; id: string; data: string; replay?: boolean; seq?: number; truncated?: boolean }
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
/** Longest tab name the user can give. */
const MAX_NAME = 40
/** Ended terminals kept for their output; past this the oldest ones are forgotten. */
const MAX_EXITED = 10
/** Live shells at once; past this a new one is refused (the RPC reports the error to the client). */
const MAX_TERMINALS = 32
/** Commands running at once inside one agent terminal; past this the next one is refused. */
const MAX_AGENT_CHILDREN = 8

const noLog: Pick<Logger, 'error' | 'warn'> = { error: () => {}, warn: () => {} }

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

/** Looking for the shell scans PATH (~15 ms on Windows) and its answer rarely changes. */
const SHELL_TTL_MS = 60_000
let shellCache: { at: number; spec: ShellSpec } | undefined
function cachedDefaultShell(): ShellSpec {
  const now = Date.now()
  if (!shellCache || now - shellCache.at > SHELL_TTL_MS) {
    shellCache = { at: now, spec: defaultShell() }
  }
  return shellCache.spec
}

interface Terminal {
  info: TerminalInfo
  pty: PtyProcess
  buffer: string
  seq: number
  pending: string
  timer: ReturnType<typeof setTimeout> | null
  subscribers: Set<TerminalSubscriber>
  paused: boolean
  poll: ReturnType<typeof setInterval> | null
  exitedAt?: number
  /** End of the output seen so far, so a URL split across two writes is still detected. */
  tail: string
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
      maxTerminals?: number
      maxAgentChildren?: number
      maxPtys?: number
      log?: Pick<Logger, 'error' | 'warn'>
    } = {},
  ) {}

  private get log(): Pick<Logger, 'error' | 'warn'> {
    return this.options.log ?? noLog
  }

  create(params: {
    cwd: string
    cols?: number
    rows?: number
    shell?: ShellSpec
    /** Run as a shell command whose exit status is retained by the terminal. */
    command?: string
    title?: string
    /** A running script is reused within the same folder. */
    scriptId?: string
  }): TerminalInfo {
    if (params.scriptId) {
      for (const t of this.terminals.values()) {
        if (
          t.info.scriptId === params.scriptId &&
          sameFolder(t.info.cwd, params.cwd) &&
          t.info.exited === undefined
        )
          return snapshot(t)
      }
    }
    this.makeRoom()
    this.checkPtyLimit()
    let shell = params.shell ?? (this.options.shell ?? cachedDefaultShell)()
    const cols = params.cols ?? 80
    const rows = params.rows ?? 24
    const env = {
      ...(this.options.env ?? process.env),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as Record<string, string>

    if (
      params.command &&
      process.platform === 'win32' &&
      /^(powershell|pwsh)(\.exe)?$/i.test(path.win32.basename(shell.file))
    ) {
      shell = { file: env.COMSPEC ?? 'cmd.exe', args: [], name: 'cmd' }
    }
    const args = params.command ? commandArgs(shell, params.command) : shell.args
    const pty = (this.options.pty ?? defaultPty)(shell.file, args, {
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
      seq: 0,
      pending: '',
      timer: null,
      subscribers: new Set(),
      paused: false,
      tail: '',
      poll: null,
    }
    this.terminals.set(id, term)
    this.changed(term)

    // A throw inside a pty callback would surface as an uncaught exception and could stop the
    // host; here it costs this terminal's stream only.
    pty.onData((data) => {
      try {
        this.onData(term, data)
      } catch (err) {
        this.log.error(
          `terminal ${id} output failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })
    pty.onExit(({ exitCode }) => {
      try {
        this.onExit(term, exitCode)
      } catch (err) {
        this.log.error(
          `terminal ${id} exit failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })
    return { ...term.info }
  }

  /** Refuses new terminals at the live limit; ended output has its own retention limit. */
  private makeRoom() {
    const max = this.options.maxTerminals ?? MAX_TERMINALS
    const live = [...this.terminals.values()].filter((t) => t.info.exited === undefined).length
    if (live >= max) throw new Error('too many terminals open (' + max + ')')
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
    // One listener throwing (a connection mid-close, say) must not break the others or the host.
    for (const l of this.changeListeners) {
      try {
        l(change)
      } catch (err) {
        this.log.error(
          `terminal change listener failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  /** Sends a frame to every subscriber of a terminal; one that throws is skipped, not fatal. */
  private emit(term: Terminal, frame: TerminalFrame) {
    for (const s of term.subscribers) {
      try {
        s.send(frame)
      } catch (err) {
        this.log.error(
          `terminal ${term.info.id} subscriber failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
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
    this.makeRoom()
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
      seq: 0,
      pending: '',
      timer: null,
      subscribers: new Set(),
      paused: false,
      tail: '',
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
    if (data) {
      try {
        this.onData(term, data)
      } catch (err) {
        this.log.error(
          `agent terminal ${id} output failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
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
    const maxChildren = this.options.maxAgentChildren ?? MAX_AGENT_CHILDREN
    if (channel.children.size >= maxChildren)
      throw new Error(`too many commands running in this terminal (${maxChildren})`)
    this.checkPtyLimit()
    const child = (this.options.pty ?? defaultPty)(file, args, {
      cwd: options.cwd,
      env,
      cols: channel.cols,
      rows: channel.rows,
    })
    channel.children.add(child)
    channel.focus ??= child
    child.onExit(() => {
      try {
        channel.children.delete(child)
        if (channel.focus === child) channel.focus = null
      } catch (err) {
        this.log.error(
          `agent command exit failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })
    if (term.paused) child.pause()
    return child
  }

  /** Sends what the user types in agent terminal `id` to this command of its. */
  focusAgentChild(id: string, child: PtyProcess) {
    const channel = this.terminals.get(id)?.pty
    if (channel instanceof AgentChannel && channel.children.has(child)) channel.focus = child
  }

  /** Gives the tab the user's name; an empty one goes back to the default. */
  rename(id: string, name: string): TerminalInfo {
    const term = this.require(id)
    const next = name.trim().slice(0, MAX_NAME)
    if (next) term.info.name = next
    else delete term.info.name
    this.changed(term)
    return snapshot(term)
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
  attach(id: string, subscriber: TerminalSubscriber, afterSeq?: number): () => void {
    const term = this.require(id)
    // Current subscribers get what is waiting in the batch now; the new one receives it below as
    // part of the history, so nobody sees it twice or misses it.
    this.flush(term)
    const start = term.seq - term.buffer.length
    const covered = afterSeq !== undefined && afterSeq >= start && afterSeq <= term.seq
    if (covered) {
      const data = term.buffer.slice(afterSeq - start)
      if (data) this.emitTo(term, subscriber, { t: 'term.out', id, data, seq: term.seq })
    } else {
      this.emitTo(term, subscriber, {
        t: 'term.out',
        id,
        data: term.buffer,
        replay: true,
        seq: term.seq,
        ...(start > 0 || (afterSeq !== undefined && afterSeq > term.seq)
          ? { truncated: true }
          : {}),
      })
    }
    if (term.info.exited !== undefined) {
      this.emitTo(term, subscriber, { t: 'term.exit', id, code: term.info.exited })
    }
    term.subscribers.add(subscriber)
    return () => term.subscribers.delete(subscriber)
  }

  /** Sends one frame to one subscriber without letting a throw escape. */
  private emitTo(term: Terminal, subscriber: TerminalSubscriber, frame: TerminalFrame) {
    try {
      subscriber.send(frame)
    } catch (err) {
      this.log.error(
        `terminal ${term.info.id} subscriber failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
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
    this.emit(term, { t: 'term.exit', id, code: term.info.exited ?? null })
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
    term.seq += data.length
    this.scanPreviews(term, data)
    term.buffer += data
    if (term.buffer.length > BUFFER_CHARS) {
      let start = term.buffer.length - BUFFER_CHARS
      // Do not retain only the second half of a Unicode character.
      const code = term.buffer.charCodeAt(start)
      const previous = term.buffer.charCodeAt(start - 1)
      if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start++
      term.buffer = term.buffer.slice(start)
    }
    term.pending += data
    if (term.pending.length >= FLUSH_CHARS) this.flush(term)
    else term.timer ??= setTimeout(() => this.guard(() => this.flush(term)), FLUSH_MS)
  }

  /**
   * Looks for preview URLs in new output (cheap check first: only scan when it mentions a local
   * address or a scheme), and tells clients when a terminal gains one.
   */
  private scanPreviews(term: Terminal, data: string) {
    if (!/https?:|localhost|127\.0\.0\.1|0\.0\.0\.0|::1/i.test(data)) {
      term.tail = (term.tail + data).slice(-512)
      return
    }
    const found = detectPreviewUrls(data, term.tail)
    term.tail = (term.tail + data).slice(-512)
    if (found.length === 0) return
    const merged = mergePreviews(term.info.previews, found)
    const same =
      merged.length === (term.info.previews?.length ?? 0) &&
      merged.every((u, i) => u === term.info.previews?.[i])
    if (same) return
    term.info.previews = merged
    this.changed(term)
  }

  /** Every preview URL currently detected, across all terminals, newest first within each. */
  previews(): PreviewEntry[] {
    const out: PreviewEntry[] = []
    for (const term of this.terminals.values()) {
      for (const url of term.info.previews ?? [])
        out.push({
          url,
          terminalId: term.info.id,
          ...((term.info.title ?? term.info.name)
            ? { title: term.info.title ?? term.info.name }
            : {}),
          cwd: term.info.cwd,
          ...(term.info.agent?.sessionId ? { sessionId: term.info.agent.sessionId } : {}),
        })
    }
    return out
  }

  /** Sends the batch to subscribers, then applies backpressure. */
  private flush(term: Terminal) {
    if (term.timer) clearTimeout(term.timer)
    term.timer = null
    const data = term.pending
    term.pending = ''
    if (!data) return
    this.emit(term, { t: 'term.out', id: term.info.id, data, seq: term.seq })
    this.applyBackpressure(term)
  }

  private checkPtyLimit() {
    const count = [...this.terminals.values()].reduce(
      (n, t) =>
        n +
        (t.pty instanceof AgentChannel ? t.pty.children.size : Number(t.info.exited === undefined)),
      0,
    )
    const max = this.options.maxPtys ?? MAX_TERMINALS
    if (count >= max) throw new Error('too many ptys running (' + max + ')')
  }

  private guard(fn: () => void) {
    try {
      fn()
    } catch (err) {
      this.log.error('terminal callback failed: ' + String(err))
    }
  }

  private backlog(term: Terminal) {
    let worst = 0
    for (const subscriber of term.subscribers) {
      try {
        worst = Math.max(worst, subscriber.backlog())
      } catch {
        term.subscribers.delete(subscriber)
      }
    }
    return worst
  }

  private applyBackpressure(term: Terminal) {
    if (term.paused || term.info.exited !== undefined) return
    const worst = this.backlog(term)
    if (worst <= HIGH_WATER) return
    term.paused = true
    this.guard(() => term.pty.pause())
    term.poll = setInterval(() => {
      const behind = this.backlog(term)
      if (behind >= LOW_WATER && term.subscribers.size > 0) return
      term.paused = false
      if (term.poll) clearInterval(term.poll)
      term.poll = null
      this.guard(() => term.pty.resume())
    }, POLL_MS)
  }

  private onExit(term: Terminal, code: number) {
    this.flush(term)
    this.clearTimers(term)
    term.info.exited = code
    term.exitedAt = Date.now()
    this.emit(term, { t: 'term.exit', id: term.info.id, code })
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

function commandArgs(shell: ShellSpec, command: string): string[] {
  const name = path
    .basename(shell.file)
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (name === 'cmd') return [...shell.args, '/d', '/s', '/c', command]
  if (name === 'powershell' || name === 'pwsh')
    return [
      ...shell.args,
      '-Command',
      `${command}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }`,
    ]
  return [...shell.args, '-c', command]
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
