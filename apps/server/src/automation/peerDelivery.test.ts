import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EventStore, type PeerDelivery } from '../store/eventStore.ts'
import { recoverPeerDeliveries } from './peerDelivery.ts'

const message: PeerDelivery = {
  messageId: 'delivery-1',
  threadId: 'thread',
  senderId: 'sender',
  recipientId: 'recipient',
  text: 'hello',
  prompt: 'Message from agent: hello',
  at: 1,
}

describe('peer delivery recovery', () => {
  for (const crash of ['before delivery', 'after delivery', 'after marking'] as const) {
    it(`recovers exactly one visible message after a crash ${crash}`, () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'peer-delivery-'))
      const file = path.join(dir, 'events.db')
      try {
        const first = new EventStore(file)
        first.enqueuePeerDelivery(message)
        if (crash !== 'before delivery') first.deliverPeerMessage(message)
        if (crash === 'after marking') first.markPeerDelivered(message.messageId)
        first.close()

        const restarted = new EventStore(file)
        const wake = vi.fn()
        const error = vi.fn()
        recoverPeerDeliveries(restarted, wake, error)
        recoverPeerDeliveries(restarted, wake, error)
        expect(error).not.toHaveBeenCalled()
        expect(restarted.peerDeliveries(true)).toEqual(crash === 'after marking' ? [] : [message])
        for (const id of ['sender', 'recipient']) {
          const messages = restarted
            .readSession(id)
            .filter(({ event }) => event.type === 'agent.message')
          expect(messages).toHaveLength(1)
          expect(messages[0]!.event).toMatchObject({ messageId: message.messageId, text: 'hello' })
        }
        expect(
          restarted.readSession('recipient').filter(({ event }) => event.type === 'prompt.queued'),
        ).toHaveLength(1)
        expect(wake).toHaveBeenCalledWith(message)
        restarted.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
