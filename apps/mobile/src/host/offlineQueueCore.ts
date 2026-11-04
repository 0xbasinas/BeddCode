/** A message stays on the phone until the host acknowledges it. */
export interface QueuedMessage {
  id: string
  hostKey: string
  sessionId: string
  text: string
  attachments: string[]
  mode: 'auto' | 'queue'
  turns: number
  state: 'queued' | 'sending' | 'uncertain' | 'review'
}

/** Never automatically repeat a send whose acknowledgement may have been lost. */
export function restoreQueue(items: QueuedMessage[]): QueuedMessage[] {
  return items.map((item) => (item.state === 'sending' ? { ...item, state: 'uncertain' } : item))
}

export function needsReview(item: QueuedMessage, turns: number | undefined): boolean {
  return turns === undefined || item.turns !== turns
}
