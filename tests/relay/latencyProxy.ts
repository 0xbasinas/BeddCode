import net from 'node:net'

export interface Shape {
  /** Delay added to every chunk in each direction, in milliseconds (round trip is twice this). */
  delayMs: number
  /** Bandwidth limit per direction in kilobits per second; unlimited when absent. */
  kbps?: number
}

/**
 * A TCP proxy that makes a link behave like a real network: it delays each chunk, limits bandwidth,
 * counts bytes, and can cut every connection. WebSocket traffic passes through unchanged, so a
 * host, a relay or a client can be pointed at it without knowing. Order is always preserved.
 */
export class LatencyProxy {
  /** Bytes sent toward the target (`up`) and back from it (`down`) since the last `resetCounters`. */
  bytes = { up: 0, down: 0 }
  /** Why connections ended, for working out what dropped a link. */
  closes: { atMs: number; side: string; error?: string }[] = []
  private shape: Shape = { delayMs: 0 }
  private readonly server = net.createServer((client) => this.accept(client))
  private readonly sockets = new Set<net.Socket>()

  constructor(private readonly target: { host: string; port: number }) {}

  get port(): number {
    return (this.server.address() as net.AddressInfo).port
  }

  configure(shape: Shape) {
    this.shape = shape
  }

  resetCounters() {
    this.bytes = { up: 0, down: 0 }
  }

  listen(): Promise<number> {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this.port)))
  }

  /** Cuts every open connection, as a network drop does. */
  dropAll() {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  async close() {
    this.dropAll()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private accept(client: net.Socket) {
    const upstream = net.connect(this.target.port, this.target.host)
    for (const socket of [client, upstream]) {
      socket.setNoDelay(true)
      this.sockets.add(socket)
      const side = socket === client ? 'client' : 'target'
      let error: string | undefined
      socket.on('error', (e) => {
        error = e.message
        socket.destroy()
      })
      socket.on('close', () => {
        this.sockets.delete(socket)
        this.closes.push({ atMs: Date.now(), side, error })
      })
    }
    this.pipe(client, upstream, 'up')
    this.pipe(upstream, client, 'down')
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  }

  private pipe(from: net.Socket, to: net.Socket, direction: 'up' | 'down') {
    let transmitFree = 0
    // Chunks wait in one queue with one timer: separate timers could fire out of order and would
    // corrupt the stream.
    const queue: { at: number; chunk: Buffer | null }[] = []
    let timer: NodeJS.Timeout | undefined
    const drain = () => {
      timer = undefined
      while (queue.length && queue[0]!.at <= Date.now()) {
        const { chunk } = queue.shift()!
        if (to.destroyed) return void (queue.length = 0)
        if (chunk) to.write(chunk)
        else to.end()
      }
      if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0]!.at - Date.now()))
    }
    const enqueue = (at: number, chunk: Buffer | null) => {
      queue.push({ at, chunk })
      if (!timer) drain()
    }
    from.on('data', (chunk) => {
      this.bytes[direction] += chunk.length
      const { delayMs, kbps } = this.shape
      const now = Date.now()
      // The chunk occupies the link for its transmission time, then travels for the delay.
      transmitFree = Math.max(transmitFree, now) + (kbps ? (chunk.length * 8) / kbps : 0)
      enqueue(Math.max(transmitFree + delayMs, queue.at(-1)?.at ?? 0), chunk)
    })
    from.on('end', () => enqueue(queue.at(-1)?.at ?? 0, null))
  }
}
