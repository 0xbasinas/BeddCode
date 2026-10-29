type Answer = { result?: unknown; error?: string }
type Entry = {
  socket: WebSocket
  resolve: (answer: Answer) => void
  timer: ReturnType<typeof setTimeout>
}

/** In-flight calls are tied to the socket they were sent to and are never replayed. */
export class PendingCalls {
  private readonly entries = new Map<string, Entry>()

  get size() {
    return this.entries.size
  }

  wait(id: string, socket: WebSocket, timeoutMs: number): Promise<Answer> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          this.finish(id, {
            error:
              'Host did not answer. The operation may have started; check BeddCode before retrying.',
          }),
        timeoutMs,
      )
      this.entries.set(id, { socket, resolve, timer })
    })
  }

  finish(id: string, answer: Answer, socket?: WebSocket) {
    const entry = this.entries.get(id)
    if (!entry || (socket && entry.socket !== socket)) return
    this.entries.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(answer)
  }

  disconnected(socket: WebSocket) {
    for (const [id, entry] of this.entries) {
      if (entry.socket === socket)
        this.finish(id, {
          error:
            'Host disconnected. The operation may have started; check BeddCode before retrying.',
        })
    }
  }
}
