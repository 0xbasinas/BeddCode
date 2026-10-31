import { describe, expect, it } from 'vitest'
import { PiEventMapper } from './mapper.ts'

describe('PiEventMapper', () => {
  it('maps text and command tool events', () => {
    const mapper = new PiEventMapper('s1', () => 7)
    mapper.setTurn('turn-1')
    expect(mapper.map({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })).toMatchObject([
      { type: 'message.delta', role: 'assistant', text: 'hello', sessionId: 's1', turnId: 'turn-1', at: 7 },
    ])
    expect(mapper.map({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash', args: { command: 'git status' } })).toMatchObject([
      { type: 'tool.started', toolId: 'x', kind: 'command', command: 'git status' },
    ])
    expect(mapper.map({ type: 'tool_execution_end', toolCallId: 'x', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] } })).toMatchObject([
      { type: 'tool.completed', toolId: 'x', ok: true, output: 'ok', approval: 'not-asked' },
    ])
  })
})
