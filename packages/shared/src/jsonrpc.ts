import readline from 'node:readline'
import type { Logger } from './log.ts'
import { killProcessTree, spawnProcess } from './process.ts'

/** How long an agent has to exit by itself once its input is closed. */
const CLOSE_GRACE_MS = 1_500

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
    /** What the other end attached to the error (agents often put the real reason here). */
    readonly data?: unknown,
  ) {
    super(message)
  }
}

const DETAIL_KEYS = ['details', 'errorMessage', 'message', 'detail', 'title']

/** The reason an error's `data` gives, if it gives one: a string under a usual key, or nested under `error`. */
export function rpcErrorDetail(data: unknown, depth = 0): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data) || depth > 3) return undefined
  const record = data as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return rpcErrorDetail(record.error, depth + 1)
}

/** An error as one line for the user: the message, and the agent's own reason when it adds to it. */
export function describeRpcError(err: unknown): string {
  if (err instanceof JsonRpcError) {
    const detail = rpcErrorDetail(err.data)
    return detail && !err.message.includes(detail) ? `${err.message}: ${detail}` : err.message
  }
  return err instanceof Error ? err.message : String(err)
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
      error?: { code?: number; message?: string; data?: unknown }
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
      // Some agents answer with the id as a string ("7" for 7); it is the same request.
      const key =
        typeof msg.id === 'string' && !this.pending.has(msg.id) && /^\d+$/.test(msg.id)
          ? Number(msg.id)
          : msg.id
      const p = this.pending.get(key)
      if (!p) return
      this.pending.delete(key)
      if (msg.error) {
        p.reject(
          new JsonRpcError(
            msg.error.code ?? -32000,
            msg.error.message ?? 'request failed',
            msg.error.data,
          ),
        )
      } else p.resolve(msg.result)
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
      if (!this.closed)
        this.write({ id, error: { code: e.code, message: e.message, data: e.data } })
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
      // Closing its input is the polite way to ask it to finish; whatever is still running a
      // moment later, with everything it started, is ended.
      child.stdin.end()
      const timer = setTimeout(() => killProcessTree(child), CLOSE_GRACE_MS)
      timer.unref?.()
      child.once('close', () => clearTimeout(timer))
    },
    stderrTail: () => tail.trim(),
  }
}
