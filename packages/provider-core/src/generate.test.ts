import { describe, expect, it, vi } from 'vitest'
import { createAsyncQueue } from '@beddcode/shared'
import type { SessionEvent } from '@beddcode/contracts'
import type { ProviderSession } from './adapter.ts'
import { generateSessionText } from './generate.ts'

function helper(events: SessionEvent[], fail?: Error) {
  const queue = createAsyncQueue<SessionEvent>()
  const close = vi.fn(async () => queue.close())
  const session: ProviderSession = {
    sessionId: 'helper',
    events: queue,
    prompt: async () => {
      if (fail) throw fail
      events.forEach((e) => queue.push(e))
    },
    close,
    interrupt: async () => {},
    setPermissionMode: async () => {},
    respondToApproval: async () => {},
  }
  return { session, close }
}
const base = { sessionId: 'helper', at: 0 }

describe('isolated text generation', () => {
  it('collects a fast streaming response and always closes the helper', async () => {
    const { session, close } = helper([
      { ...base, type: 'message.delta', role: 'assistant', text: 'Hello ' },
      { ...base, type: 'message.delta', role: 'assistant', text: 'world' },
      { ...base, type: 'turn.completed', reason: 'done' },
    ])
    expect(await generateSessionText(session, 'describe')).toBe('Hello world')
    expect(close).toHaveBeenCalledOnce()
  })
  it('rejects attempted tool use and provider failures instead of returning a partial draft', async () => {
    const { session, close } = helper([
      { ...base, type: 'tool.started', toolId: 't', kind: 'command', title: 'git commit' },
    ])
    await expect(generateSessionText(session, 'describe')).rejects.toThrow('tried to use a tool')
    expect(close).toHaveBeenCalledOnce()
    const failed = helper([], new Error('Not signed in'))
    await expect(generateSessionText(failed.session, 'describe')).rejects.toThrow('Not signed in')
    expect(failed.close).toHaveBeenCalledOnce()
  })
  it('ends hung generation after its deadline', async () => {
    vi.useFakeTimers()
    try {
      const { session, close } = helper([])
      const result = expect(generateSessionText(session, 'describe')).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(120_000)
      await result
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
