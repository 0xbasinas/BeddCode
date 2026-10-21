import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeEventMapper, diffForTool, toolKind, toolTitle } from './mapper.ts'

const msg = (m: unknown) => m as SDKMessage

function mapAll(messages: unknown[]) {
  const mapper = new ClaudeEventMapper('s1', { now: () => 1 })
  mapper.setTurn('turn-1')
  return messages.flatMap((m) => mapper.map(msg(m)))
}

describe('ClaudeEventMapper', () => {
  it('announces the provider session id from the init message', () => {
    const events = mapAll([{ type: 'system', subtype: 'init', session_id: 'abc' }])
    expect(events).toMatchObject([{ type: 'session.provider-session', providerSessionId: 'abc' }])
  })

  it('streams text deltas and does not repeat the final assistant text', () => {
    const events = mapAll([
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'message_start', message: { id: 'm1' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }] },
      },
    ])
    const text = events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : []))
    expect(text).toEqual(['Hel', 'lo'])
    expect(events.every((e) => e.turnId === 'turn-1' && e.sessionId === 's1')).toBe(true)
  })

  it('emits assistant text when it was not streamed', () => {
    const events = mapAll([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: 'm2', content: [{ type: 'text', text: 'Whole message' }] },
      },
    ])
    expect(events).toMatchObject([
      { type: 'message.delta', role: 'assistant', text: 'Whole message' },
    ])
  })

  it('maps a tool call, its result and a diff only after the edit succeeds', () => {
    const events = mapAll([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'm3',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Edit',
              input: { file_path: 'src/a.ts', old_string: 'a\nb', new_string: 'c' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      },
    ])
    expect(events.map((e) => e.type)).toEqual(['tool.started', 'tool.completed', 'diff'])
    expect(events[0]).toMatchObject({ kind: 'edit', title: 'Editing src/a.ts' })
    expect(events[2]).toMatchObject({ path: 'src/a.ts', added: 1, removed: 2 })
  })

  it('emits no diff when the edit tool fails', () => {
    const events = mapAll([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'm4',
          content: [
            { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'x', content: 'y' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'denied' }],
        },
      },
    ])
    expect(events.map((e) => e.type)).toEqual(['tool.started', 'tool.completed'])
    expect(events[1]).toMatchObject({ ok: false, output: 'denied' })
  })

  it('maps results: done, error, and cancelled after an interrupt', () => {
    expect(
      mapAll([{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }]),
    ).toMatchObject([{ type: 'turn.completed', reason: 'done' }])

    const failed = mapAll([
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] },
    ])
    expect(failed).toMatchObject([
      { type: 'error', message: 'boom' },
      { type: 'turn.completed', reason: 'error' },
    ])

    const mapper = new ClaudeEventMapper('s1', { now: () => 1 })
    mapper.markInterrupted()
    const cancelled = mapper.map(
      msg({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] }),
    )
    expect(cancelled).toMatchObject([{ type: 'turn.completed', reason: 'cancelled' }])
    // The flag only applies to one result.
    const next = mapper.map(
      msg({ type: 'result', subtype: 'success', is_error: false, result: '' }),
    )
    expect(next).toMatchObject([{ type: 'turn.completed', reason: 'done' }])
  })
})

describe('tool helpers', () => {
  it('classifies tools and titles them', () => {
    expect(toolKind('Bash')).toBe('command')
    expect(toolKind('Grep')).toBe('search')
    expect(toolKind('mcp__x__y')).toBe('other')
    expect(toolTitle('Bash', { command: 'ls -la' })).toBe('Running Bash: ls -la')
    expect(toolTitle('Read', { file_path: 'a.ts' })).toBe('Reading a.ts')
    expect(toolTitle('mcp__github__create_issue', {})).toBe('Using github · create_issue')
  })

  it('builds diffs for edits, multi-edits and writes', () => {
    expect(
      diffForTool('Edit', { file_path: 'f', old_string: 'x', new_string: 'y\nz' }),
    ).toMatchObject({
      added: 2,
      removed: 1,
      patch: '-x\n+y\n+z',
    })
    expect(
      diffForTool('MultiEdit', {
        file_path: 'f',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      }),
    ).toMatchObject({ added: 2, removed: 2 })
    expect(diffForTool('Write', { file_path: 'f', content: 'l1\nl2' })).toMatchObject({
      added: 2,
      removed: 0,
    })
    expect(diffForTool('Bash', { command: 'ls' })).toBeNull()
  })
})
