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

  it('reports a compaction from its start to the boundary it leaves', () => {
    const events = mapAll([
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'system', subtype: 'status', status: null },
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 9000 },
      },
      { type: 'system', subtype: 'status', status: null, compact_result: 'failed' },
    ])
    expect(events).toMatchObject([
      { type: 'session.compaction', state: 'started' },
      {
        type: 'session.compaction',
        state: 'finished',
        trigger: 'auto',
        tokensBefore: 150000,
        tokensAfter: 9000,
      },
      { type: 'session.compaction', state: 'failed' },
    ])
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

  it('keeps the arguments of MCP tool calls only', () => {
    const events = mapAll([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'm9',
          content: [
            {
              type: 'tool_use',
              id: 't9',
              name: 'mcp__beddcode__start_session',
              input: { agent: 'codex', prompt: 'hi' },
            },
            { type: 'tool_use', id: 't10', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
    ])
    expect(events[0]).toMatchObject({
      type: 'tool.started',
      title: 'Using beddcode · start_session',
      input: JSON.stringify({ agent: 'codex', prompt: 'hi' }, null, 2),
    })
    expect(events[1]).not.toHaveProperty('input')
  })

  it('names a Bash command and hands its whole output to the terminal before completing', () => {
    const long = 'x'.repeat(10_000)
    const events = mapAll([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'm4',
          content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: long }] },
      },
    ])
    expect(events.map((e) => e.type)).toEqual(['tool.started', 'tool.output', 'tool.completed'])
    expect(events[0]).toMatchObject({ command: 'ls' })
    expect(events[1]).toMatchObject({ toolId: 'b1', data: long })
    // The conversation keeps its short copy.
    const done = events[2] as { output?: string }
    expect(done.output!.length).toBeLessThan(long.length)
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

describe('ClaudeEventMapper usage', () => {
  const result = (modelUsage: Record<string, unknown>) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    modelUsage,
  })
  const used = (input: number, output: number, cost: number, cacheRead = 0) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: 0,
    costUSD: cost,
  })
  const usageOf = (events: { type: string }[]) => events.filter((e) => e.type === 'session.usage')

  it('reports what each turn added, from the running totals the SDK keeps', () => {
    const mapper = new ClaudeEventMapper('s1', { now: () => 1 })
    const first = mapper.map(msg(result({ 'claude-sonnet-5-5': used(1000, 200, 0.05, 400) })))
    expect(usageOf(first)).toMatchObject([
      {
        model: 'claude-sonnet-5-5',
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 400,
        costUsd: 0.05,
      },
    ])
    const second = mapper.map(
      msg(
        result({
          'claude-sonnet-5-5': used(1800, 350, 0.09, 900),
          'claude-haiku-5-5': used(50, 10, 0.001),
        }),
      ),
    )
    expect(usageOf(second)).toMatchObject([
      { model: 'claude-sonnet-5-5', inputTokens: 800, outputTokens: 150, cacheReadTokens: 500 },
      { model: 'claude-haiku-5-5', inputTokens: 50, outputTokens: 10 },
    ])
    // A turn that used nothing says nothing.
    expect(
      usageOf(mapper.map(msg(result({ 'claude-sonnet-5-5': used(1800, 350, 0.09, 900) })))),
    ).toEqual([])
  })

  it('counts everything again when the totals start over', () => {
    const mapper = new ClaudeEventMapper('s1', { now: () => 1 })
    mapper.map(msg(result({ m: used(5000, 900, 0.3) })))
    const after = mapper.map(msg(result({ m: used(100, 20, 0.01) })))
    expect(usageOf(after)).toMatchObject([{ model: 'm', inputTokens: 100, outputTokens: 20 }])
  })

  it("does not count a resumed conversation's earlier turns a second time", () => {
    const mapper = new ClaudeEventMapper('s1', { now: () => 1, resumed: true })
    expect(usageOf(mapper.map(msg(result({ m: used(5000, 900, 0.3) }))))).toEqual([])
    expect(usageOf(mapper.map(msg(result({ m: used(5600, 1000, 0.34) }))))).toMatchObject([
      { inputTokens: 600, outputTokens: 100 },
    ])
  })

  it('says nothing when the result carries no usage', () => {
    expect(
      usageOf(mapAll([{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }])),
    ).toEqual([])
  })
})
