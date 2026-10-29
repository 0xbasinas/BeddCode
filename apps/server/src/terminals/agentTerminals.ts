import path from 'node:path'
import type { SessionEvent } from '@beddcode/contracts'
import type {
  AgentCommand,
  AgentCommandExit,
  AgentCommandRequest,
  AgentTerminalHost,
} from '@beddcode/provider-core'
import { quoteForCmd, resolveExecutable } from '@beddcode/shared'
import type { PtyProcess, TerminalManager } from './manager.ts'

/** Output an agent gets back when it does not set a limit: the end of it, at most this much. */
export const DEFAULT_OUTPUT_BYTES = 512_000
/** At most this much of one mirrored command's output is shown. */
export const MIRROR_OUTPUT_CHARS = 64_000

export interface AgentSessionInfo {
  sessionId: string
  cwd: string
  label: string
  instanceId?: string
  title?: string
  /**
   * The agent can run its commands in our ptys (ACP agents). Its command tool calls are then
   * mirrored only when it ran them some other way (no pty was used for them).
   */
  hostsCommands: boolean
}

interface MirroredTool {
  command: string
  /** Shown in the terminal yet (held back for agents that may run it in a pty instead). */
  shown: boolean
  streamed: number
  ptyRuns: number
  /** Output held back until we know whether the tool ran in a pty. */
  held: string
  /** The last character of output shown, to end the output on its own line. */
  last?: string
}

interface PtyRun {
  id: number
  display: string
  cwd: string
  /** Output waiting for the commands before it to finish. */
  held: string
  child: PtyProcess | null
  exit: AgentCommandExit | null
  /** Its header is on screen: it is, or was, the command shown. */
  shown?: boolean
}

/** At most this much output of a command waits while another one is shown. */
const HELD_OUTPUT_CHARS = 256_000

interface SessionState {
  info: AgentSessionInfo
  terminalId?: string
  tools: Map<string, MirroredTool>
  /** Commands running in our ptys right now. */
  running: Map<number, string>
  /** Pty commands not yet shown to the end, in the order they started. */
  runs: PtyRun[]
  /** Output of command calls not announced yet, by tool id. */
  early: Map<string, string>
  ptyRuns: number
  /** The agent is gone: nothing more is shown (a command it left may still report its end). */
  ended?: boolean
}

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

/**
 * Each session's agent terminal: the commands its agent runs, shown live in the Terminal pane.
 * ACP agents ask the host to run their commands (`terminal/create`); those really run here, in a
 * pty the user watches and can take over. Claude Code and Codex run commands inside their own
 * process; their command tool calls are mirrored from the session's events instead (Codex streams
 * the output, Claude reports it when the command ends).
 */
export class AgentTerminals {
  private readonly sessions = new Map<string, SessionState>()
  private nextRun = 1

  constructor(
    private readonly terminals: TerminalManager,
    private readonly options: { platform?: NodeJS.Platform } = {},
  ) {}

  /** Registers a session; returns the host to give an agent that can run commands in our ptys. */
  register(info: AgentSessionInfo): AgentTerminalHost {
    const existing = this.sessions.get(info.sessionId)
    if (existing) existing.info = info
    else
      this.sessions.set(info.sessionId, {
        info,
        tools: new Map(),
        running: new Map(),
        runs: [],
        early: new Map(),
        ptyRuns: 0,
      })
    return { run: (request) => this.run(info.sessionId, request) }
  }

  /** The session's title changed; new agent terminals use it. */
  retitle(sessionId: string, title: string) {
    const s = this.sessions.get(sessionId)
    if (s) s.info = { ...s.info, title }
  }

  /** The agent's process ended. Its terminal stays for reading until closed or forgotten. */
  ended(sessionId: string) {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.sessions.delete(sessionId)
    s.ended = true
    if (s.terminalId) this.terminals.endAgentTerminal(s.terminalId)
  }

  /** The id of the session's agent terminal, opening it when needed. */
  private terminal(s: SessionState): string {
    if (s.terminalId && this.terminals.has(s.terminalId)) {
      const t = this.terminals.list().find((x) => x.id === s.terminalId)
      if (t && t.exited === undefined) return s.terminalId
    }
    s.terminalId = this.terminals.agentTerminal({
      cwd: s.info.cwd,
      sessionId: s.info.sessionId,
      label: s.info.label,
      instanceId: s.info.instanceId,
      sessionTitle: s.info.title,
      mode: s.info.hostsCommands ? 'pty' : 'mirror',
    })
    return s.terminalId
  }

  private write(s: SessionState, data: string) {
    if (s.ended) return
    const id = this.terminal(s)
    if (!this.terminals.feed(id, data)) {
      // Closed meanwhile: open a fresh one.
      s.terminalId = undefined
      this.terminals.feed(this.terminal(s), data)
    }
  }

  private updateRunning(s: SessionState) {
    if (!s.terminalId) return
    const mirrored = [...s.tools.values()]
      .filter((t) => t.shown)
      .map((t) => displayCommand(t.command))
    const now = [...s.running.values(), ...mirrored].at(-1)
    this.terminals.setRunning(s.terminalId, now)
  }

  private header(s: SessionState, command: string, cwd?: string) {
    const where =
      cwd && path.resolve(cwd) !== path.resolve(s.info.cwd)
        ? path.relative(s.info.cwd, cwd) || '.'
        : ''
    const lines = command.replace(/\r?\n/g, '\r\n  ')
    this.write(s, `${DIM}${where ? `${where} ` : ''}$${RESET} ${BOLD}${lines}${RESET}\r\n`)
  }

  private footer(s: SessionState, code: number | null, signal?: string | null) {
    if (code === 0) this.write(s, '\r\n')
    else
      this.write(
        s,
        `${code === null ? DIM : RED}[${signal ? `stopped (${signal})` : `exit ${code ?? '?'}`}]${RESET}\r\n\r\n`,
      )
  }

  /** ACP `terminal/create`: runs the command in a pty shown in the agent terminal. */
  run(sessionId: string, req: AgentCommandRequest): AgentCommand {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('The session has ended')
    const display = displayCommand(req.command, req.args)
    s.ptyRuns++
    // Whatever command tool call is open now is this command: do not mirror it as well.
    for (const t of s.tools.values()) t.ptyRuns++
    const { file, args } = commandLine(req.command, req.args ?? [], this.options.platform)
    const limit =
      req.outputByteLimit === null || req.outputByteLimit === undefined
        ? DEFAULT_OUTPUT_BYTES
        : Math.max(0, req.outputByteLimit)
    const run: PtyRun = {
      id: this.nextRun++,
      display,
      cwd: req.cwd,
      held: '',
      child: null,
      exit: null,
    }
    let output = ''
    let truncated = false
    const waiters: ((e: AgentCommandExit) => void)[] = []
    const finish = (e: AgentCommandExit) => {
      if (run.exit) return
      run.exit = e
      s.running.delete(run.id)
      this.updateRunning(s)
      this.settle(s)
      for (const w of waiters.splice(0)) w(e)
    }

    s.runs.push(run)
    try {
      run.child = this.terminals.spawnInAgentTerminal(this.terminal(s), file, args, {
        cwd: req.cwd,
        env: req.env ?? {},
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      output = `${message}\n`
      run.held = `${RED}${message}${RESET}\r\n`
    }
    // Shown now, or once the commands started before it have finished (agents run some at once).
    this.settle(s)
    if (!run.child) {
      finish({ exitCode: 127, signal: null })
    } else {
      s.running.set(run.id, display)
      this.updateRunning(s)
      run.child.onData((data) => {
        output += agentText(data)
        if (Buffer.byteLength(output) > limit) {
          // Keep the tail: the end of the output is what an agent needs most.
          output = Buffer.from(output).subarray(-limit).toString('utf8')
          truncated = true
        }
        if (s.runs[0] === run) this.write(s, data)
        else if (run.held.length < HELD_OUTPUT_CHARS) run.held += data
      })
      run.child.onExit((e: { exitCode: number; signal?: number }) =>
        finish({
          exitCode: e.signal ? null : e.exitCode,
          signal: e.signal ? `signal ${e.signal}` : null,
        }),
      )
    }
    const kill = () => {
      if (run.exit || !run.child) return
      try {
        run.child.kill()
      } catch {
        // already gone
      }
    }
    return {
      output: () => ({ output, truncated, exitStatus: run.exit }),
      waitForExit: () =>
        run.exit ? Promise.resolve(run.exit) : new Promise((resolve) => waiters.push(resolve)),
      kill,
      release: kill,
    }
  }

  /**
   * Shows the agent's commands one after another: the first one still unfinished owns the screen
   * (and the keyboard, once taken over); output of commands that run beside it waits its turn.
   */
  private settle(s: SessionState) {
    while (s.runs.length) {
      const first = s.runs[0]!
      if (!first.shown) {
        first.shown = true
        this.header(s, first.display, first.cwd)
        if (first.held) this.write(s, first.held)
        first.held = ''
        if (first.child && s.terminalId) this.terminals.focusAgentChild(s.terminalId, first.child)
      }
      if (!first.exit) return
      this.footer(s, first.exit.exitCode, first.exit.signal)
      s.runs.shift()
    }
  }

  /** Mirrors command tool calls (and their streamed output) into the session's agent terminal. */
  observe(event: SessionEvent) {
    const s = this.sessions.get(event.sessionId)
    if (!s) return
    switch (event.type) {
      case 'tool.started':
      case 'tool.updated': {
        if (event.type === 'tool.started' && event.kind !== 'command') return
        if (event.type === 'tool.updated' && event.kind !== 'command' && !s.tools.has(event.toolId))
          return
        const command = commandOf(event)
        const known = s.tools.get(event.toolId)
        if (known) {
          if (command && !known.shown) known.command = command
          return
        }
        if (!command) return
        const tool: MirroredTool = { command, shown: false, streamed: 0, ptyRuns: 0, held: '' }
        s.tools.set(event.toolId, tool)
        const early = s.early.get(event.toolId)
        if (early) {
          s.early.delete(event.toolId)
          tool.held = early
          tool.streamed = early.length
        }
        if (!s.info.hostsCommands) this.show(s, tool)
        return
      }
      case 'tool.output': {
        const tool = s.tools.get(event.toolId)
        if (!tool) {
          // Output can arrive before the call that makes it is announced: keep a little of it.
          const early = s.early.get(event.toolId) ?? ''
          if (early.length < MIRROR_OUTPUT_CHARS && (s.early.has(event.toolId) || s.early.size < 8))
            s.early.set(event.toolId, (early + event.data).slice(0, MIRROR_OUTPUT_CHARS))
          return
        }
        if (tool.ptyRuns > 0) return
        const room = MIRROR_OUTPUT_CHARS - tool.streamed
        if (room <= 0) return
        const data = event.data.slice(0, room)
        tool.streamed += data.length
        if (!tool.shown) {
          tool.held += data
          return
        }
        this.output(s, tool, data)
        if (tool.streamed >= MIRROR_OUTPUT_CHARS)
          this.write(
            s,
            `\r\n${DIM}[output cut off; the full result is in the conversation]${RESET}`,
          )
        return
      }
      case 'tool.completed': {
        const tool = s.tools.get(event.toolId)
        if (!tool) return
        s.tools.delete(event.toolId)
        // It ran in our pty, which already showed it.
        if (tool.ptyRuns > 0) return this.updateRunning(s)
        if (!tool.shown) this.show(s, tool)
        if (tool.streamed === 0 && event.output) this.output(s, tool, event.output)
        if (tool.last !== undefined && tool.last !== '\n') this.write(s, '\r\n')
        this.write(s, event.ok ? '\r\n' : `${RED}[failed]${RESET}\r\n\r\n`)
        this.updateRunning(s)
        return
      }
      case 'turn.completed':
        s.early.clear()
        // Anything still open will not report back any more.
        if (s.tools.size > 0) {
          s.tools.clear()
          this.updateRunning(s)
        }
        return
    }
  }

  private output(s: SessionState, tool: MirroredTool, text: string) {
    if (!text) return
    tool.last = text.at(-1)
    this.write(s, terminalText(text))
  }

  private show(s: SessionState, tool: MirroredTool) {
    tool.shown = true
    this.header(s, displayCommand(tool.command))
    if (tool.held) {
      this.output(s, tool, tool.held)
      tool.held = ''
    }
    this.updateRunning(s)
  }
}

function commandOf(event: {
  command?: string
  input?: string
  title?: string
}): string | undefined {
  if (event.command?.trim()) return event.command
  if (event.input) {
    try {
      const parsed = JSON.parse(event.input) as { command?: unknown; cmd?: unknown }
      const c = parsed.command ?? parsed.cmd
      if (typeof c === 'string' && c.trim()) return c
      if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c.join(' ')
    } catch {
      // not JSON
    }
  }
  return undefined
}

/** `bash -lc 'ls -la'` → `ls -la`: what the agent meant to run, for the terminal. */
export function displayCommand(command: string, args?: string[]): string {
  if (args && args.length > 0) {
    const shell = /(?:^|[\\/])(?:ba|z|da|k)?sh(?:\.exe)?$/i.test(command)
    const flag = args[0]
    if (shell && args.length === 2 && flag !== undefined && /^-l?c$/.test(flag)) return args[1]!
    return [command, ...args].map(quoteIfNeeded).join(' ')
  }
  const inner =
    /^(?:"[^"]*"|\S*?)(?:ba|z|da|k)?sh(?:\.exe)?\s+-l?c\s+'((?:[^']|'\\'')*)'$/s.exec(
      command,
    )?.[1] ?? /^(?:"[^"]*"|\S*?)(?:ba|z|da|k)?sh(?:\.exe)?\s+-l?c\s+"(.*)"$/s.exec(command)?.[1]
  if (inner !== undefined) return inner.replace(/'\\''/g, "'")
  // `bash -lc ls`: one word, no quotes.
  return (
    /^(?:"[^"]*"|\S*?)(?:ba|z|da|k)?sh(?:\.exe)?\s+-l?c\s+([^\s'"]+)$/.exec(command)?.[1] ?? command
  )
}

function quoteIfNeeded(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`
}

/** How to start an agent's command in a pty: a whole shell line goes through the shell. */
export function commandLine(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  const windows = platform === 'win32'
  if (args.length === 0 && /\s/.test(command)) {
    return windows
      ? { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { file: '/bin/sh', args: ['-c', command] }
  }
  const file = resolveExecutable(command) ?? command
  if (windows && /\.(cmd|bat)$/i.test(file)) {
    return {
      file: process.env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/c', [file, ...args].map(quoteForCmd).join(' ')],
    }
  }
  return { file, args }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

/** What a pty printed, as plain text for the agent: no colours or cursor codes, `\n` lines. */
export function agentText(data: string): string {
  return data.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '')
}

/** Plain output shown in a terminal: lines need `\r\n`. */
function terminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}
