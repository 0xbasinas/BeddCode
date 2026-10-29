import { describe, expect, it } from 'vitest'
import { GrokEventMapper, rawOutputText, toolKind, usageFromEnd } from './mapper.ts'

const run = (lines: unknown[]) => {
  const mapper = new GrokEventMapper('s1', () => 1)
  mapper.setTurn('turn-1')
  return lines.flatMap((l) => mapper.map(l))
}

describe('GrokEventMapper', () => {
  it('streams text and drops thoughts, usage and unknown lines', () => {
    const events = run([
      { type: 'text', data: 'Hi' },
      { type: 'thought', data: 'hmm' },
      { type: 'usage', usage: { input_tokens: 1 }, signature: 'x' },
    ])
    expect(events).toMatchObject([
      { type: 'message.delta', role: 'assistant', text: 'Hi', turnId: 'turn-1' },
    ])
  })

  it('reports a compaction of the conversation', () => {
    expect(
      run([
        { type: 'auto_compact_started' },
        { type: 'auto_compact_completed', tokens_before: 90000, tokens_after: 12000 },
      ]),
    ).toMatchObject([
      { type: 'session.compaction', state: 'started' },
      { type: 'session.compaction', state: 'finished', tokensBefore: 90000, tokensAfter: 12000 },
    ])
  })

  it('follows a tool through the real call and update lines', () => {
    const events = run([
      {
        type: 'tool_call',
        toolCallId: 'c1',
        title: 'read_file',
        kind: 'read',
        status: 'pending',
        toolName: 'read_file',
        rawInput: { target_file: 'a.txt' },
        content: [],
        locations: [],
      },
      {
        type: 'tool_call_update',
        toolCallId: 'c1',
        status: null,
        content: [],
        rawOutput: null,
        locations: [{ path: 'a.txt' }],
      },
      {
        type: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '1→hello\n' } }],
        rawOutput: { type: 'ReadFile' },
        locations: [],
      },
    ])
    expect(events).toMatchObject([
      { type: 'tool.started', toolId: 'c1', kind: 'read', title: 'read_file' },
      { type: 'tool.updated', toolId: 'c1', paths: ['a.txt'] },
      { type: 'tool.completed', toolId: 'c1', ok: true, output: '1→hello\n' },
    ])
  })

  it('titles a shell tool by its command and reads output from a wrapped raw output', () => {
    const events = run([
      {
        type: 'tool_call',
        toolCallId: 'c2',
        title: 'run_terminal_command',
        kind: 'execute',
        rawInput: { command: 'echo x' },
      },
      {
        type: 'tool_call_update',
        toolCallId: 'c2',
        status: 'completed',
        rawOutput: { type: 'ListDir', Content: { content: '- a.txt', absolute_root_path: '/w' } },
      },
    ])
    expect(events).toMatchObject([
      { type: 'tool.started', kind: 'command', title: 'echo x' },
      { type: 'tool.completed', ok: true, output: '- a.txt' },
    ])
  })

  it('emits a diff only when an edit succeeds', () => {
    const edit = (status: string) =>
      run([
        { type: 'tool_call', toolCallId: 'e', title: 'search_replace', kind: 'edit' },
        {
          type: 'tool_call_update',
          toolCallId: 'e',
          status,
          content: [{ type: 'diff', path: '/w/a.txt', oldText: 'hello\n', newText: 'bye\n' }],
        },
      ])
    expect(edit('completed').map((e) => e.type)).toEqual(['tool.started', 'tool.completed', 'diff'])
    expect(edit('failed').map((e) => e.type)).toEqual(['tool.started', 'tool.completed'])
  })

  it('announces the command list once, however often it is repeated', () => {
    const line = {
      type: 'available_commands',
      tools: ['read_file'],
      commands: ['compact', 'review'],
    }
    const events = run([line, line, line])
    expect(events).toMatchObject([
      { type: 'session.commands', commands: [{ name: 'compact' }, { name: 'review' }] },
    ])
  })

  it('maps plan entries', () => {
    expect(
      run([{ type: 'plan', entries: [{ content: 'a', status: 'in_progress' }, { content: 'b' }] }]),
    ).toMatchObject([
      {
        type: 'plan.updated',
        steps: [
          { text: 'a', status: 'in-progress' },
          { text: 'b', status: 'pending' },
        ],
      },
    ])
  })

  it('closes tools that never finished', () => {
    const mapper = new GrokEventMapper('s1', () => 1)
    mapper.map({ type: 'tool_call', toolCallId: 'x', title: 't', kind: 'other' })
    expect(mapper.abandonOpenTools()).toMatchObject([
      { type: 'tool.completed', toolId: 'x', ok: false },
    ])
    expect(mapper.abandonOpenTools()).toEqual([])
  })
})

describe('helpers', () => {
  it('maps kinds', () => {
    expect(toolKind('execute')).toBe('command')
    expect(toolKind('list')).toBe('read')
    expect(toolKind('fetch')).toBe('search')
    expect(toolKind(undefined)).toBe('other')
  })

  it('falls back to JSON for output with no readable text', () => {
    expect(rawOutputText({ n: 1 })).toBe('{"n":1}')
    expect(rawOutputText(null)).toBeUndefined()
  })

  it('reads usage per model from the end line', () => {
    const end = {
      type: 'end',
      usage: { input_tokens: 15567, output_tokens: 104 },
      total_cost_usd: 0.0335,
      modelUsage: {
        'grok-4.7-build-fast': {
          inputTokens: 15567,
          outputTokens: 104,
          cacheReadInputTokens: 35200,
          cacheCreationInputTokens: 0,
          costUSD: 0.0335,
        },
      },
    }
    expect(usageFromEnd(end)).toEqual([
      {
        type: 'session.usage',
        model: 'grok-4.7-build-fast',
        inputTokens: 15567,
        outputTokens: 104,
        cacheReadTokens: 35200,
        costUsd: 0.0335,
      },
    ])
  })

  it('falls back to the totals when there is no per-model breakdown', () => {
    expect(usageFromEnd({ usage: { input_tokens: 5, output_tokens: 2 } })).toEqual([
      { type: 'session.usage', inputTokens: 5, outputTokens: 2 },
    ])
    expect(usageFromEnd({})).toEqual([])
  })
})
