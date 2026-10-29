import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { SessionEvent } from '@beddcode/contracts'
import type { ProviderSession, PromptInput, StartSessionInput } from '@beddcode/provider-core'
import { createAsyncQueue, spawnProcess, type Logger } from '@beddcode/shared'
import { DEFAULT_MODE, TEXT_ONLY_FLAGS, grokModeOptions, grokModes, modeFlags } from './modes.ts'
import { GrokEventMapper, usageFromEnd } from './mapper.ts'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never
type Obj = Record<string, unknown>

export type SpawnFn = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

const isWindows = process.platform === 'win32'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
/** After an interrupt, how long Grok has to save its state before it is stopped for good. */
const KILL_GRACE_MS = 5_000
/** How much of Grok's stderr is kept to explain a failure. */
const STDERR_KEEP = 4_000

export interface GrokSessionDeps {
  /** Path to the user's installed `grok` binary. */
  executablePath: string
  env?: Record<string, string | undefined>
  log: Logger
  /** Injected in tests. */
  spawnFn?: SpawnFn
  /** Injected in tests: how a running process is stopped. */
  /** Looks up the title Grok gave a conversation; used once, after the first answer. */
  titleFn?: (grokSessionId: string) => Promise<string | undefined>
  stopFn?: (child: ChildProcessWithoutNullStreams, how: 'graceful' | 'force') => void
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Grok has no long-lived mode that can ask for approval, so each message is one `grok -p` run. */
export class GrokSession implements ProviderSession {
  readonly sessionId: string
  private readonly queue = createAsyncQueue<SessionEvent>()
  private readonly mapper: GrokEventMapper
  private modeId: string
  private model: string | undefined
  private effort: string | undefined
  /** Grok's id for this conversation, once it has one; later messages resume it. */
  private grokSessionId: string | undefined
  private turnCount = 0
  private child: ChildProcessWithoutNullStreams | undefined
  private running = false
  private interrupted = false
  private closed = false
  private named = false
  private killTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly input: StartSessionInput,
    private readonly deps: GrokSessionDeps,
  ) {
    this.sessionId = input.sessionId
    this.mapper = new GrokEventMapper(input.sessionId)
    this.grokSessionId = input.resumeId
    this.model = input.model
    this.effort = input.effort
    this.modeId = grokModes.some((m) => m.id === input.permissionMode)
      ? input.permissionMode!
      : DEFAULT_MODE
    if (!input.textOnly) {
      this.emit({ type: 'session.modes', modes: grokModeOptions, currentModeId: this.modeId })
    }
  }

  get events() {
    return this.queue
  }

  private emit(draft: Draft, turnId?: string) {
    this.queue.push({ ...draft, sessionId: this.sessionId, turnId, at: Date.now() } as SessionEvent)
  }

  private push(events: SessionEvent[]) {
    for (const e of events) this.queue.push(e)
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.closed) throw new Error('session is closed')
    if (this.running) throw new Error('Grok is still working on the previous message.')
    this.running = true
    this.interrupted = false
    const turnId = `turn-${++this.turnCount}`
    this.mapper.setTurn(turnId)
    this.emit({ type: 'turn.started' }, turnId)

    let dir: string | undefined
    try {
      // The prompt goes in a file: no quoting, no length limit, and text that starts with a dash
      // cannot be mistaken for a flag.
      dir = await mkdtemp(path.join(os.tmpdir(), 'beddcode-grok-'))
      const file = path.join(dir, 'prompt.txt')
      await writeFile(file, await this.promptPayload(input), 'utf8')
      const outcome = await this.run(file, turnId)
      this.finishTurn(outcome, turnId)
    } catch (err) {
      this.push(this.mapper.abandonOpenTools())
      this.emit(
        { type: 'error', message: err instanceof Error ? err.message : String(err) },
        turnId,
      )
      this.emit({ type: 'turn.completed', reason: 'error' }, turnId)
    } finally {
      this.running = false
      this.child = undefined
      if (dir) void rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * The prompt file's content. Plain text goes as it is; pictures turn it into content blocks,
   * which Grok reads from the same file. Text that starts like JSON is wrapped too, so Grok cannot
   * mistake the user's words for blocks.
   */
  private async promptPayload(input: PromptInput): Promise<string> {
    const images = this.input.textOnly ? [] : await imageBlocks(input.attachments)
    if (images.length === 0 && !/^\s*[[{]/.test(input.text)) return input.text
    return JSON.stringify([{ type: 'text', text: input.text }, ...images])
  }

  private args(promptFile: string, resuming: string | undefined, freshId: string): string[] {
    const text = this.input.textOnly === true
    return [
      '--no-auto-update',
      '--no-alt-screen',
      '--cwd',
      this.input.cwd,
      '--output-format',
      'streaming-json',
      '--prompt-file',
      promptFile,
      ...(text ? TEXT_ONLY_FLAGS : modeFlags(this.modeId)),
      ...(this.model ? ['--model', this.model] : []),
      ...(this.effort ? ['--reasoning-effort', this.effort] : []),
      ...(text ? [] : (this.input.additionalDirectories ?? []).flatMap((d) => ['--add-dir', d])),
      ...(resuming ? ['--resume', resuming] : ['--session-id', freshId]),
    ]
  }

  /** Runs Grok for one message and reports how the process ended. */
  private run(promptFile: string, turnId: string): Promise<RunOutcome> {
    // A first message names its session up front; if that run produced nothing, the next one
    // starts over under a new name instead of resuming a session that never existed.
    const freshId = randomUUID()
    const resuming = this.input.textOnly ? undefined : this.grokSessionId
    const args = this.args(promptFile, resuming, freshId)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.deps.env,
      GROK_DISABLE_AUTOUPDATER: '1',
    }
    const launch = this.deps.spawnFn ?? ((f, a, o) => spawnProcess(f, a, o) as never)

    return new Promise<RunOutcome>((resolve) => {
      const outcome: RunOutcome = { stderr: '', code: null, signal: null }
      let child: ChildProcessWithoutNullStreams
      try {
        child = launch(this.deps.executablePath, args, { cwd: this.input.cwd, env })
      } catch (err) {
        outcome.spawnError = err instanceof Error ? err.message : String(err)
        resolve(outcome)
        return
      }
      this.child = child
      child.stdin.on('error', () => {})
      child.stdin.end()

      let buffer = ''
      const decoder = new StringDecoder('utf8')
      const line = (raw: string) => {
        if (!raw.trim()) return
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          this.deps.log.debug(`ignored a line that is not JSON: ${raw.slice(0, 120)}`)
          return
        }
        if (isObj(parsed)) this.onLine(parsed, outcome, turnId, freshId, resuming)
      }
      const onData = (chunk: Buffer) => {
        buffer += decoder.write(chunk)
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          line(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', (chunk: Buffer) => {
        outcome.stderr = (outcome.stderr + chunk.toString('utf8')).slice(-STDERR_KEEP)
      })
      child.on('error', (err) => {
        outcome.spawnError = err.message
      })
      child.on('close', (code, signal) => {
        buffer += decoder.end()
        line(buffer)
        outcome.code = code
        outcome.signal = signal
        if (this.killTimer) clearTimeout(this.killTimer)
        this.killTimer = undefined
        resolve(outcome)
      })
    })
  }

  private onLine(
    line: Obj,
    outcome: RunOutcome,
    turnId: string,
    freshId: string,
    resuming: string | undefined,
  ) {
    switch (line.type) {
      case 'end': {
        outcome.end = {
          stopReason: typeof line.stopReason === 'string' ? line.stopReason : undefined,
          sessionId: typeof line.sessionId === 'string' ? line.sessionId : undefined,
        }
        this.adopt(outcome.end.sessionId ?? resuming ?? freshId)
        for (const usage of usageFromEnd(line)) this.emit(usage, turnId)
        return
      }
      case 'error':
        outcome.errorMessage =
          typeof line.message === 'string' && line.message ? line.message : 'Grok reported an error'
        return
      case 'max_turns_reached':
        outcome.hitLimit = true
        return
      default:
        // Any output at all means Grok created the session under the id it was given.
        if (!this.input.textOnly) this.adopt(resuming ?? freshId)
        this.push(this.mapper.map(line))
    }
  }

  /** Remembers Grok's session id, and tells the host once so the session can be resumed later. */
  private adopt(id: string) {
    if (this.grokSessionId === id) return
    this.grokSessionId = id
    this.emit({ type: 'session.provider-session', providerSessionId: id })
  }

  private finishTurn(outcome: RunOutcome, turnId: string) {
    this.push(this.mapper.abandonOpenTools())
    const label = 'Grok'
    const fail = (message: string) => {
      this.emit({ type: 'error', message }, turnId)
      this.emit({ type: 'turn.completed', reason: 'error' }, turnId)
    }

    if (this.interrupted || outcome.end?.stopReason === 'cancelled') {
      this.emit({ type: 'turn.completed', reason: 'cancelled' }, turnId)
    } else if (outcome.spawnError) {
      fail(`${label} could not be started: ${outcome.spawnError}`)
    } else if (outcome.errorMessage) {
      fail(this.explain(outcome.errorMessage, outcome.stderr))
    } else if (outcome.end) {
      const reason = outcome.end.stopReason
      if (reason === undefined || reason === 'end_turn') {
        if (outcome.hitLimit) fail(`${label} stopped because it reached its limit of steps.`)
        else {
          this.emit({ type: 'turn.completed', reason: 'done' }, turnId)
          this.nameSession()
        }
      } else fail(stopMessage(reason))
    } else if (outcome.code === 0) {
      // Exited cleanly without its closing line: whatever it said is all there is.
      this.emit({ type: 'turn.completed', reason: 'done' }, turnId)
    } else {
      const tail = outcome.stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
      fail(
        this.explain(
          tail ?? `${label} stopped unexpectedly (exit code ${outcome.code ?? outcome.signal})`,
          outcome.stderr,
        ),
      )
    }
  }

  /** Grok titles a conversation itself; the first title it gives names the session here. */
  private nameSession() {
    const id = this.grokSessionId
    if (this.named || this.input.textOnly || !id || !this.deps.titleFn) return
    this.named = true
    void this.deps
      .titleFn(id)
      .then((title) => {
        if (title && !this.closed)
          this.emit({ type: 'session.renamed', title: title.slice(0, 120) })
        else this.named = false
      })
      .catch((err) => {
        this.named = false
        this.deps.log.debug('could not read the title Grok gave the session', err)
      })
  }

  /** A sign-in problem gets the fix; anything else keeps Grok's own words. */
  private explain(message: string, stderr: string): string {
    if (
      /log.?in|sign.?in|unauthori[sz]ed|api.?key|credential|not authenticated|401/i.test(
        message + stderr,
      )
    ) {
      return 'Grok needs you to sign in. Run `grok login` in a terminal, or set XAI_API_KEY, then try again.'
    }
    return message.slice(0, 400)
  }

  async interrupt() {
    const child = this.child
    if (!child || !this.running) return
    this.interrupted = true
    ;(this.deps.stopFn ?? stop)(child, 'graceful')
    // Grok saves its state on SIGINT; one that is slow to do so is stopped for good.
    this.killTimer = setTimeout(() => (this.deps.stopFn ?? stop)(child, 'force'), KILL_GRACE_MS)
    this.killTimer.unref?.()
  }

  async setPermissionMode(modeId: string) {
    if (!grokModes.some((m) => m.id === modeId))
      throw new Error(`Unknown permission mode: ${modeId}`)
    this.modeId = modeId
    // Takes effect with the next message: a run in progress keeps the policy it started with.
    this.emit({ type: 'session.modes', modes: grokModeOptions, currentModeId: modeId })
  }

  async setModel(model: string | undefined, effort: string | undefined) {
    this.model = model
    this.effort = effort
  }

  async respondToApproval(requestId: string): Promise<void> {
    throw new Error(`No pending approval ${requestId}`)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    if (this.child && this.running) {
      this.interrupted = true
      ;(this.deps.stopFn ?? stop)(this.child, 'force')
    }
    if (this.killTimer) clearTimeout(this.killTimer)
    this.queue.close()
  }
}

/** Pictures that fit, as image blocks; every file is also named in the message text. */
async function imageBlocks(files: string[] | undefined): Promise<Obj[]> {
  const blocks: Obj[] = []
  for (const file of files ?? []) {
    const mimeType = IMAGE_TYPES[path.extname(file).toLowerCase()]
    if (!mimeType) continue
    try {
      if ((await stat(file)).size > MAX_IMAGE_BYTES) continue
      blocks.push({ type: 'image', mimeType, data: (await readFile(file)).toString('base64') })
    } catch {
      // Grok can still read the file by the path in the text.
    }
  }
  return blocks
}

interface RunOutcome {
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  spawnError?: string
  errorMessage?: string
  hitLimit?: boolean
  end?: { stopReason?: string; sessionId?: string }
}

function stopMessage(reason: string): string {
  switch (reason) {
    case 'max_tokens':
      return 'Grok stopped because it reached its output limit.'
    case 'max_turn_requests':
    case 'max_turns':
      return 'Grok stopped because it reached its limit of steps.'
    case 'refusal':
      return 'Grok declined to continue with this request.'
    default:
      return `Grok stopped: ${reason}`
  }
}

/** Windows has no SIGINT to send, so there the whole process tree is ended. */
function stop(child: ChildProcessWithoutNullStreams, how: 'graceful' | 'force') {
  if (child.pid === undefined || child.exitCode !== null) return
  if (isWindows) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  } else {
    child.kill(how === 'graceful' ? 'SIGINT' : 'SIGKILL')
  }
}
