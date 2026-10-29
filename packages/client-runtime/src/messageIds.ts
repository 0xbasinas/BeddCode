/**
 * Ids that make sending a message safe to repeat (see `clientMessageId` on sessions.prompt).
 *
 * A send whose answer never came (the connection dropped) may still have reached the host. When
 * the same message is sent again, it gets the same id, and the host answers it without sending it
 * to the agent a second time. A send that got its answer forgets its id, so the same words sent
 * later on purpose are a new message.
 */
export class MessageIds {
  private readonly open = new Map<string, { id: string; at: number }>()

  constructor(
    private readonly keepMs = 10 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The id for this attempt at a message, and a function to call once the host answered it. */
  begin(
    sessionId: string,
    text: string,
    attachmentIds: readonly string[] = [],
  ): { id: string; done: () => void } {
    const now = this.clock()
    for (const [key, entry] of this.open) if (now - entry.at > this.keepMs) this.open.delete(key)
    const key = JSON.stringify([sessionId, text, attachmentIds])
    const entry = this.open.get(key) ?? { id: newId(), at: now }
    entry.at = now
    this.open.set(key, entry)
    return {
      id: entry.id,
      done: () => {
        if (this.open.get(key) === entry) this.open.delete(key)
      },
    }
  }
}

function newId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return (
    random ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  )
}
