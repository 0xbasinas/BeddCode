import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeEventMapper } from '../mapper.ts'

function map(messages: unknown[]) {
  const mapper = new ClaudeEventMapper('session', { cwd: '/work/sample', now: () => 1 })
  mapper.setTurn('turn-1')
  return messages.flatMap((message) => mapper.map(message as SDKMessage))
}

describe('Claude CLI stream messages', () => {
  it('maps the recorded edit run, including the successful diff and usage', () => {
    const lines = readFileSync(new URL('./fixtures/edit-run.jsonl', import.meta.url), 'utf8')
      .trim()
      .split('\n')
    const events = map(lines.map((line) => JSON.parse(line)))
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'session.provider-session',
        providerSessionId: '00000000-0000-4000-8000-000000000001',
      }),
    )
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.started', kind: 'edit' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', ok: true }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'diff' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'message.delta', text: 'done' }))
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'session.usage', costUsd: 0.0583331 }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'turn.completed', reason: 'done' }),
    )
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }))
  })
  it('ignores thinking blocks and shows the response', () => {
    const events = map([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'm',
          content: [
            { type: 'thinking', thinking: 'private' },
            { type: 'text', text: 'answer' },
          ],
        },
      },
    ])
    expect(events).toMatchObject([{ type: 'message.delta', text: 'answer' }])
  })
  it('reports rejected rate limits without treating rejected overage as a rejected request', () => {
    const events = map([
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', overageStatus: 'rejected' },
      },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
    ])
    expect(events).toMatchObject([{ type: 'error', message: 'Claude rate limit reached.' }])
  })
  it('reports execution errors and permission denials', () => {
    const events = map([
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        message: 'Denied by policy',
      },
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['failed'],
        modelUsage: {},
      },
    ])
    expect(events).toMatchObject([
      { type: 'error', message: 'Denied by policy' },
      { type: 'error', message: 'failed' },
      { type: 'turn.completed', reason: 'error' },
    ])
  })
})
