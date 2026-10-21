import { describe, expect, it } from 'vitest'
import { ClientFrame, ServerFrame, SessionEvent } from './index.ts'

describe('contracts', () => {
  it('parses a session event', () => {
    const e = SessionEvent.parse({ type: 'turn.completed', sessionId: 's1', at: 1, reason: 'done' })
    expect(e.type).toBe('turn.completed')
  })

  it('rejects an unknown event type', () => {
    expect(() => SessionEvent.parse({ type: 'nope', sessionId: 's1', at: 1 })).toThrow()
  })

  it('parses wire frames', () => {
    expect(ClientFrame.parse({ t: 'hello', protocol: 1 }).t).toBe('hello')
    const f = ServerFrame.parse({
      t: 'welcome',
      protocol: 1,
      host: { hostId: 'h', name: 'This PC', platform: 'win32', version: '0.0.0' },
    })
    expect(f.t).toBe('welcome')
  })
})
