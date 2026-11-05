import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough, Writable } from 'node:stream'
import type { Logger } from '../log.ts'

/** The wire protocol the daemon and the host speak; a daemon of another version is not used. */
export const PROTOCOL_VERSION = 2

/** Output younger than this is not acknowledged yet (see `SupervisedProcess.tryAck`). */
const ACK_DELAY_MS = 120

/** Feature flag: the supervisor is off unless this is `1`/`true`/`on`. */
export function supervisorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(env.BEDDCODE_AGENT_SUPERVISOR ?? '')
}

/**
 * How the supervisor reads the agent's stream. `claude` is the Claude CLI's stream-json; `jsonrpc`
 * is JSON-RPC over lines (Codex app-server, ACP agents, Grok).
 */
export type SupervisedProtocol = 'claude' | 'jsonrpc'

/**
 * For `jsonrpc` agents: what a host that reattaches sends again but the agent already did. Each
 * group of request methods is answered, after the first time, with the first answer given to any
 * method of the group (`thread/start` then `thread/resume`, say); `swallow` notifications are dropped.
 */
export interface SupervisedHandshake {
  memo: string[][]
  swallow?: string[]
}

export interface SupervisedSpawn {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string | undefined>
  protocol?: SupervisedProtocol
  handshake?: SupervisedHandshake
}

/** What the host keeps in the supervisor next to an agent, to pick up where it left off. */
export type AgentMeta = Record<string, unknown>

export interface AgentInfo {
  id: string
  pid: number
  alive: boolean
  size: number
  acked: number
  attached: boolean
  meta?: AgentMeta
}

interface Info {
  pid: number
  endpoint: string
  token: string
}

type Frame = Record<string, unknown> & { op: string }

/** A line-framed JSON connection to the daemon. */
export class Connection {
  private buffer = ''
  private readonly listeners: ((frame: Frame) => void)[] = []
  closed = false
  readonly onClose: (() => void)[] = []

  constructor(readonly socket: net.Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      for (let nl = this.buffer.indexOf('\n'); nl !== -1; nl = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        try {
          const frame = JSON.parse(line) as Frame
          for (const l of [...this.listeners]) l(frame)
        } catch {
          // a damaged line is skipped
        }
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.closed = true
      for (const l of this.onClose) l()
    })
  }

  send(frame: Frame) {
    if (!this.closed && !this.socket.destroyed) this.socket.write(JSON.stringify(frame) + '\n')
  }

  listen(fn: (frame: Frame) => void) {
    this.listeners.push(fn)
    return () => {
      const i = this.listeners.indexOf(fn)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  /** The first frame matching `match`, or an error frame / closed connection. */
  next(match: (f: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => done(new Error('the agent supervisor did not answer')),
        timeoutMs,
      )
      const off = this.listen((f) => {
        if (match(f)) done(undefined, f)
        else if (f.op === 'error') done(undefined, f)
      })
      this.onClose.push(() => done(new Error('the agent supervisor closed the connection')))
      const done = (err?: Error, f?: Frame) => {
        clearTimeout(timer)
        off()
        if (err) reject(err)
        else resolve(f!)
      }
    })
  }

  close() {
    this.socket.end()
  }
}

/**
 * Talks to the agent supervisor daemon, starting it when it is not running. One daemon serves one
 * data folder; the host and the daemon share nothing but the socket and a token file.
 */
export class SupervisorClient {
  private starting: Promise<Info> | undefined

  constructor(
    readonly dir: string,
    private readonly options: { daemonEnv?: NodeJS.ProcessEnv; log?: Pick<Logger, 'warn'> } = {},
  ) {}

  private readInfo(): Info | undefined {
    try {
      return JSON.parse(readFileSync(path.join(this.dir, 'supervisor.json'), 'utf8')) as Info
    } catch {
      return undefined
    }
  }

  private async open(info: Info): Promise<Connection> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(info.endpoint)
      s.once('connect', () => resolve(s))
      s.once('error', reject)
    })
    const conn = new Connection(socket)
    const hello = conn.next((f) => f.op === 'hello')
    conn.send({ op: 'hello', token: info.token })
    const reply = await hello
    if (reply.op !== 'hello' || reply.version !== PROTOCOL_VERSION) {
      conn.close()
      throw new Error('the agent supervisor refused the connection or speaks another version')
    }
    return conn
  }

  private async daemon(): Promise<Info> {
    const existing = this.readInfo()
    if (existing) {
      try {
        const c = await this.open(existing)
        c.close()
        return existing
      } catch {
        // stale file: the daemon is gone
      }
    }
    this.starting ??= this.startDaemon().finally(() => (this.starting = undefined))
    return this.starting
  }

  private async startDaemon(): Promise<Info> {
    mkdirSync(this.dir, { recursive: true })
    const script = daemonScript()
    // Started through a launcher that exits at once: the daemon then has no live parent, so
    // `taskkill /T` (or a process-group kill) aimed at the host's tree cannot reach it.
    const launcher = `require('node:child_process').spawn(process.execPath,[process.argv[1],'--dir',process.argv[2]],{detached:true,stdio:['ignore','inherit','inherit'],windowsHide:true}).unref()`
    const logFd = openSync(path.join(this.dir, 'daemon.log'), 'a')
    try {
      spawn(process.execPath, ['-e', launcher, script, this.dir], {
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
        env: { ...process.env, ...this.options.daemonEnv },
      }).unref()
    } finally {
      closeSync(logFd)
    }
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40))
      const info = this.readInfo()
      if (info && existsSync(path.join(this.dir, 'supervisor.json'))) {
        try {
          const c = await this.open(info)
          c.close()
          return info
        } catch {
          // not listening yet
        }
      }
    }
    throw new Error('the agent supervisor did not start')
  }

  async connect(): Promise<Connection> {
    return this.open(await this.daemon())
  }

  /** Agents the supervisor holds, or none when it is not running (it is not started for this). */
  async list(): Promise<AgentInfo[]> {
    const info = this.readInfo()
    if (!info) return []
    let conn: Connection
    try {
      conn = await this.open(info)
    } catch {
      return []
    }
    try {
      const reply = conn.next((f) => f.op === 'agents')
      conn.send({ op: 'list' })
      return ((await reply).agents as AgentInfo[] | undefined) ?? []
    } finally {
      conn.close()
    }
  }

  /**
   * Starts an agent the supervisor owns from now on. The process object is usable at once (the SDK
   * needs one synchronously); what is written to it waits for the connection.
   */
  spawn(id: string, spec: SupervisedSpawn, meta: AgentMeta): SupervisedProcess {
    const proc = new SupervisedProcess(meta)
    this.connect().then(
      (conn) => {
        conn.send({ op: 'spawn', id, ...spec, meta })
        proc.bind(conn)
      },
      (err: unknown) => proc.fail(err instanceof Error ? err : new Error(String(err))),
    )
    return proc
  }

  /** Takes over an agent a previous host left running, or undefined when there is none alive. */
  async attach(id: string): Promise<SupervisedProcess | undefined> {
    if (!this.readInfo()) return undefined
    let conn: Connection
    try {
      conn = await this.connect()
    } catch {
      return undefined
    }
    const proc = new SupervisedProcess(undefined)
    // Listening before asking: the replay follows the answer directly.
    const reply = conn.next((f) => f.op === 'attached')
    proc.bind(conn)
    conn.send({ op: 'attach', id })
    const attached = await reply
    if (attached.op === 'error' || attached.alive === false) {
      conn.send({ op: 'release' })
      proc.detach()
      return undefined
    }
    proc.adopt(Number(attached.pid), attached.meta as AgentMeta | undefined)
    return proc
  }
}

/**
 * Stands in for the agent's own process in the SDK: its stdin and stdout are the supervisor's
 * frames. Output is acknowledged once it reached the SDK, so a later host is given only what this
 * one did not take in.
 */
export class SupervisedProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  /** The agent's stderr, for callers that read it as they would a child process's. */
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  pid: number
  meta: AgentMeta | undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  stderrTail = ''
  /**
   * True when everything handed to the session so far has been processed (its events saved). The
   * session sets it; without one, output counts as processed after the short delay alone.
   */
  ackGate: () => boolean = () => true
  /**
   * How old output must be before it is acknowledged. A session that handles each line as it
   * arrives (JSON-RPC, Pi) sets 0: with its queue idle the events are saved, and the acknowledgement
   * follows in the same turn of the event loop. One that hears of lines later (Claude's SDK reads
   * the pipe on its own) keeps the default.
   */
  ackDelayMs = ACK_DELAY_MS
  private readonly unacked: { off: number; at: number }[] = []
  private ackTimer: ReturnType<typeof setInterval> | undefined
  /** Leave the agent running: nothing more goes to it from here. */
  private detached = false

  private conn: Connection | undefined
  private readonly queued: Frame[] = []

  constructor(meta: AgentMeta | undefined) {
    super()
    this.pid = 0
    this.meta = meta
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        this.send({ op: 'in', data: chunk.toString() })
        cb()
      },
      final: (cb) => {
        this.send({ op: 'close-stdin' })
        cb()
      },
    })
    this.stdin.on('error', () => {})
  }

  /** Connects the process to the supervisor and sends what was written before that. */
  bind(conn: Connection) {
    this.conn = conn
    conn.listen((f) => this.onFrame(f))
    conn.onClose.push(() => {
      // The supervisor went away (or let go of us): the SDK sees the agent end.
      if (!this.detached) this.finish(null, null)
    })
    for (const f of this.queued.splice(0)) conn.send(f)
  }

  fail(err: Error) {
    if (this.listenerCount('error') > 0) this.emit('error', err)
    this.finish(null, null)
  }

  private send(frame: Frame) {
    if (this.detached) return
    if (this.conn) this.conn.send(frame)
    else this.queued.push(frame)
  }

  adopt(pid: number, meta: AgentMeta | undefined) {
    this.pid = pid
    this.meta = meta
  }

  private onFrame(f: Frame) {
    if (this.detached) return
    if (f.op === 'spawned') this.pid = Number(f.pid)
    else if (f.op === 'error') this.fail(new Error(String(f.message ?? f.code)))
    else if (f.op === 'out') {
      const data = String(f.data)
      this.stdout.write(data)
      const off = Number(f.off)
      if (off >= 0) {
        // Only up to the end of the last whole line counts as taken in, and only once the session
        // has processed it (see `tryAck`).
        const nl = data.lastIndexOf('\n')
        if (nl >= 0) {
          this.unacked.push({ off: off + Buffer.byteLength(data.slice(0, nl + 1)), at: Date.now() })
          this.ackTimer ??= setInterval(() => this.tryAck(), 40)
          this.ackTimer.unref?.()
          if (this.ackDelayMs === 0) setImmediate(() => this.tryAck())
        }
      }
    } else if (f.op === 'err') {
      this.stderrTail = (this.stderrTail + String(f.data)).slice(-2_000)
      this.stderr.write(String(f.data))
    } else if (f.op === 'exit') {
      this.send({ op: 'release' })
      this.finish(f.code as number | null, f.signal as NodeJS.Signals | null)
    } else if (f.op === 'detached') {
      // Another host took the agent over.
      this.detach()
    }
  }

  /**
   * Tells the supervisor what this host has taken in, so a later host is replayed only the rest.
   * Not at once on receipt: the host could die before it saved what it was given, and that would
   * be lost. Output is acknowledged when it is a moment old and the session has caught up, so what
   * can repeat after a crash is at most the last few lines, and nothing can be lost.
   */
  private tryAck(force = false) {
    if (this.unacked.length === 0 || this.detached) {
      if (this.ackTimer && this.unacked.length === 0) clearInterval(this.ackTimer)
      if (this.unacked.length === 0) this.ackTimer = undefined
      return
    }
    if (!this.ackGate()) return
    const cutoff = Date.now() - this.ackDelayMs
    let upto = -1
    for (let i = 0; i < this.unacked.length; i++)
      if (force || this.unacked[i]!.at <= cutoff) upto = i
    if (upto < 0) return
    this.send({ op: 'ack', off: this.unacked[upto]!.off })
    this.unacked.splice(0, upto + 1)
  }

  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code ?? (signal ? null : 0)
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    // The SDK reads this as "the agent ended"; a null code with no signal would look still running.
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
    this.conn?.close()
  }

  setMeta(meta: AgentMeta) {
    this.meta = meta
    this.send({ op: 'meta', meta })
  }

  /** The host is going away but the agent is not: let go without ending it. */
  detach() {
    if (this.detached) return
    // A planned goodbye: what the session has processed is acknowledged now, so nothing repeats.
    this.tryAck(true)
    this.detached = true
    if (this.ackTimer) clearInterval(this.ackTimer)
    this.conn?.close()
    this.stdout.end()
  }

  kill(_signal?: NodeJS.Signals): boolean {
    if (this.detached) return true
    this.killed = true
    this.send({ op: 'kill' })
    return true
  }
}

/** Next to this file when run from source, next to the bundle in an installed host. */
function daemonScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of [
    path.join(here, 'daemon.mjs'),
    path.join(here, 'supervisor', 'daemon.mjs'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('the agent supervisor program (daemon.mjs) is missing')
}
