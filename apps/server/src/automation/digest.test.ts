import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { describe, expect, it } from 'vitest'
import { digest } from './digest.ts'

const log = (...events: Record<string, unknown>[]): StoredEvent[] =>
  events.map((e, seq) => ({
    seq,
    event: { sessionId: 's', at: seq, ...e } as unknown as SessionEvent,
  }))

describe('digest', () => {
  it('keeps the replies around a tool call apart', () => {
    const d = digest(
      log(
        { type: 'session.created', title: 'T', cwd: '/r', instanceId: 'codex' },
        { type: 'turn.started' },
        { type: 'message.delta', role: 'user', text: 'go' },
        { type: 'message.delta', role: 'assistant', text: "I'll run " },
        { type: 'message.delta', role: 'assistant', text: 'it.' },
        { type: 'tool.started', toolId: 't', kind: 'command', title: 'Run' },
        { type: 'tool.completed', toolId: 't', ok: true },
        { type: 'message.delta', role: 'assistant', text: 'hello' },
        { type: 'turn.completed', reason: 'done' },
      ),
    )
    expect(d?.lastReply).toBe("I'll run it.\n\nhello")
    expect(d?.status).toBe('idle')
  })
})
