import readline from 'node:readline'
import type { Logger } from './log.ts'
import { spawnProcess } from './process.ts'

/** Line-oriented duplex channel; the real one wraps a child's stdio. */
export interface Transport {
  send(line: string): void
  onLine(handler: (line: string) => void): void
  onClose(handler: () => void): void
  close(): void
  /** The last lines the process wrote to stderr, to explain why it died. */
  stderrTail?(): string
}

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

type Json = unknown
type NotificationHandler = (method: string, params: Json) => void
type RequestHandler = (method: string, params: Json) => Promise<Json>

interface Pending {
  resolve(value: Json): void
  reject(reason: Error): void
}

/**
 * JSON-RPC 2.0 as spoken by `codex app-server` (newline-delimited, `jsonrpc` header omitted).
 * Bidirectional: we send requests and notifications, and the server sends both back — approvals
 * arrive as server requests we must answer.
 */
export class JsonRpcClient {
  private nextId = 1
  private readonly pending = new Map<number | string, Pending>()
  private notificationHandler: NotificationHandler = () => {}
  private requestHandler: RequestHandler = async (method) => {
    throw new JsonRpcError(-32601, `Method not found: ${method}`)
  }
  private closeHandler: () => void = () => {}
  private closed = false

  constructor(
    private readonly transport: Transport,
    private readonly log?: Logger,
    /** Standard JSON-RPC 2.0 (ACP) wants a `jsonrpc` field; Codex's app-server omits it. */
    private readonly options: { jsonrpc2?: boolean } = {},
  ) {
    transport.onLine((line) => this.receive(line))
    transport.onClose(() => {
      this.failAll(new Error('The agent process ended'))
      this.closeHandler()
    })
  }

  /** Called when the other end goes away on its own (not after our own `close()`). */
  onClose(handler: () => void) {
    this.closeHandler = handler
  }

  onNotification(handler: NotificationHandler) {
    this.notificationHandler = handler
  }

  onRequest(handler: RequestHandler) {
    this.requestHandler = handler
  }

  /** The tail of the process's stderr, if the transport keeps one. */
  get stderrTail(): string {
    return this.transport.stderrTail?.() ?? ''
  }

  request<T = Json>(
    method: string,
    params?: Json,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The agent process ended'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle =
        <V>(fn: (v: V) => void) =>
        (v: V) => {
          clearTimeout(timer)
          fn(v)
        }
      this.pending.set(id, {
        resolve: settle(resolve as (v: Json) => void),
        reject: settle(reject),
      })
      if (options.timeoutMs) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return
          reject(
            new Error(`${method} did not answer within ${Math.round(options.timeoutMs! / 1000)}s`),
          )
        }, options.timeoutMs)
      }
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: Json) {
    if (!this.closed) this.write({ method, params })
  }

  close() {
    this.failAll(new Error('closed'))
    this.transport.close()
  }

  private receive(line: string) {
    if (!line.trim()) return
    let msg: {
      id?: number | string
      method?: string
      params?: Json
      result?: Json
      error?: { code?: number; message?: string }
    }
    try {
      msg = JSON.parse(line)
    } catch {
      this.log?.warn('ignoring non-JSON line from codex', line.slice(0, 200))
      return
    }

    if (msg.method !== undefined && msg.id !== undefined) {
      void this.answer(msg.id, msg.method, msg.params)
    } else if (msg.method !== undefined) {
      try {
        this.notificationHandler(msg.method, msg.params)
      } catch (err) {
        this.log?.error(`notification handler failed for ${msg.method}`, err)
      }
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error)
        p.reject(new JsonRpcError(msg.error.code ?? -32000, msg.error.message ?? 'request failed'))
      else p.resolve(msg.result)
    }
  }

  private async answer(id: number | string, method: string, params: Json) {
    try {
      const result = await this.requestHandler(method, params)
      if (!this.closed) this.write({ id, result: result ?? {} })
    } catch (err) {
      const e =
        err instanceof JsonRpcError
          ? err
          : new JsonRpcError(-32603, err instanceof Error ? err.message : String(err))
      if (!this.closed) this.write({ id, error: { code: e.code, message: e.message } })
    }
  }

  private write(message: Record<string, unknown>) {
    this.transport.send(
      JSON.stringify(this.options.jsonrpc2 ? { jsonrpc: '2.0', ...message } : message),
    )
  }

  private failAll(error: Error) {
    this.closed = true
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }
}

/** Spawns a JSON-RPC server process (e.g. `codex app-server`, an ACP agent) as a Transport. */
export function spawnTransport(
  executable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string },
  log?: Logger,
): Transport {
  const child = spawnProcess(executable, args, options)
  let tail = ''
  const remember = (text: string) => {
    tail = (tail + text).slice(-2000)
  }
  child.stderr.on('data', (d: Buffer) => {
    remember(String(d))
    log?.debug(`${executable} stderr: ${String(d).trimEnd()}`)
  })
  // Writes to a dead process surface as EPIPE; the close handler already reports the exit.
  child.stdin.on('error', () => {})
  child.on('error', (err) => {
    remember(`${err.message}\n`)
    log?.error(`${executable} failed to start`, err)
  })

  return {
    send: (line) => {
      if (child.stdin.writable) child.stdin.write(`${line}\n`)
    },
    onLine: (handler) => readline.createInterface({ input: child.stdout }).on('line', handler),
    onClose: (handler) => child.once('close', handler),
    close: () => {
      child.stdin.end()
      child.kill()
    },
    stderrTail: () => tail.trim(),
  }
}
