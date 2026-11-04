import { describe, expect, it } from 'vitest'
import { needsReview, restoreQueue, type QueuedMessage } from './offlineQueueCore'

const item: QueuedMessage = {
  id: 'one',
  hostKey: 'host',
  sessionId: 'session',
  text: 'Follow up',
  attachments: [],
  mode: 'queue',
  turns: 2,
  state: 'queued',
}

describe('offline messages', () => {
  it('preserves queued messages but marks interrupted sends as uncertain after restart', () => {
    const restored = restoreQueue([item, { ...item, id: 'two', state: 'sending' }])
    expect(restored.map((entry) => entry.state)).toEqual(['queued', 'uncertain'])
    expect(restored[0]).toEqual(item)
  })

  it('requires review if the session advanced or is unavailable', () => {
    expect(needsReview(item, 2)).toBe(false)
    expect(needsReview(item, 3)).toBe(true)
    expect(needsReview(item, undefined)).toBe(true)
  })
})
