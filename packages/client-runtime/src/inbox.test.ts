import { describe, expect, it } from 'vitest'
import { inboxThreads } from './inbox.ts'
import type { SessionView, TranscriptItem } from './replica.ts'

const message = (
  id: string,
  messageId: string,
  senderId: string,
  text: string,
): TranscriptItem => ({
  kind: 'agent-message',
  id,
  messageId,
  threadId: 'thread',
  senderId,
  recipientId: senderId === 'a' ? 'b' : 'a',
  text,
})
const session = (id: string, items: TranscriptItem[]) => ({ id, items }) as SessionView

describe('agent inbox threads', () => {
  it('deduplicates deliveries and orders replies by event sequence across sessions', () => {
    const a = session('a', [
      message('1', 'one', 'a', 'Question'),
      message('4', 'two', 'b', 'Answer'),
    ])
    const b = session('b', [
      message('2', 'one', 'a', 'Question'),
      message('3', 'two', 'b', 'Answer'),
    ])
    expect(inboxThreads([b, a])[0]?.messages.map((m) => m.text)).toEqual(['Question', 'Answer'])
    expect(inboxThreads([a])[0]?.messages.map((m) => m.text)).toEqual(['Question', 'Answer'])
  })
  it('keeps repeated messages distinct and handles cached messages without message ids', () => {
    const one = message('1', 'one', 'a', 'Hello')
    const two = message('3', 'two', 'a', 'Hello')
    expect(inboxThreads([session('a', [one, two])])[0]?.messages).toHaveLength(2)
    if (one.kind !== 'agent-message') throw new Error('expected message')
    const old = { ...one, messageId: undefined }
    expect(
      inboxThreads([session('b', [{ ...old, id: '2' }]), session('a', [old])])[0]?.messages,
    ).toHaveLength(1)
    expect(inboxThreads([session('b', [old])])[0]?.messages).toHaveLength(1)
  })
})
