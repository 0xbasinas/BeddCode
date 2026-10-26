import type { StoredEvent } from '@beddcode/contracts'

/**
 * Joins the agent's streamed text into fewer frames on its way to one client. The first piece after
 * a quiet moment goes at once, so a reply starts without delay; pieces that follow within the
 * window are held and sent together, once. A client gets a handful of frames a second instead of
 * one per token, which on a relay means far fewer encrypted messages.
 *
 * Events stay in seq order: anything that is not the next piece of the held text sends the held
 * text first. A joined event carries the seq of its last piece, so a client that resumes from
 * where it got to never asks for pieces it already has.
 */
export class LiveCoalescer {
  private held: StoredEvent | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastSentAt = -Infinity

  constructor(
    private readonly emit: (stored: StoredEvent) => void,
    private readonly windowMs = 60,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  push(stored: StoredEvent) {
    const e = stored.event
    if (e.type !== 'message.delta' || e.role !== 'assistant') {
      this.flush()
      this.emit(stored)
      return
    }
    const held = this.held
    if (held && held.event.type === 'message.delta') {
      if (held.event.sessionId === e.sessionId && held.event.turnId === e.turnId) {
        this.held = {
          seq: stored.seq,
          event: { ...held.event, text: held.event.text + e.text, at: e.at },
        }
        return
      }
      this.flush()
    }
    const wait = this.lastSentAt + this.windowMs - this.clock()
    if (wait <= 0) {
      this.send(stored)
      return
    }
    this.held = stored
    this.timer = setTimeout(() => this.flush(), wait)
  }

  /** Sends what is held, if anything. */
  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const held = this.held
    this.held = null
    if (held) this.send(held)
  }

  /** The client is gone; nothing more is sent. */
  dispose() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.held = null
  }

  private send(stored: StoredEvent) {
    this.lastSentAt = this.clock()
    this.emit(stored)
  }
}
