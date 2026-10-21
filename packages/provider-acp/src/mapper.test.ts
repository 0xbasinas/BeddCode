import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpEventMapper, toolKind } from './mapper.ts'

const run = (updates: unknown[]) => {
  const mapper = new AcpEventMapper('s1', () => 1)
  mapper.setTurn('turn-1')
  mapper.setModes([{ id: 'default', label: 'Default' }])
  return updates.flatMap((u) => mapper.map(u as SessionUpdate))
}

describe('toolKind', () => {
  it('maps ACP tool kinds to ours', () => {
    expect(toolKind('execute')).toBe('command')
    expect(toolKind('read')).toBe('read')
    expect(toolKind('edit')).toBe('edit')
    expect(toolKind('delete')).toBe('edit')
    expect(toolKind('fetch')).toBe('search')
    expect(toolKind('think')).toBe('other')
    expect(toolKind(undefined)).toBe('other')
  })
})

describe('AcpEventMapper', () => {
  it('streams agent text and ignores other content kinds and thoughts', () => {
    const events = run([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'x', mimeType: 'image/png' },
      },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } },
    ])
    expect(events).toMatchObject([
      { type: 'message.delta', role: 'assistant', text: 'Hi', turnId: 'turn-1' },
    ])
  })

  it('announces a tool once, then completes it with its output', () => {
    const events = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Run tests',
        kind: 'execute',
        status: 'pending',
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '3 passed' } }],
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    ])
    expect(events.map((e) => e.type)).toEqual(['tool.started', 'tool.completed'])
    expect(events[0]).toMatchObject({ kind: 'command', title: 'Run tests' })
    expect(events[1]).toMatchObject({ ok: true, output: '3 passed' })
  })

  it('emits diffs from diff content only when the tool succeeds', () => {
    const diff = [{ type: 'diff', path: '/w/a.txt', oldText: 'a\nb\n', newText: 'a\nB\n' }]
    const ok = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'e1',
        title: 'Edit a.txt',
        kind: 'edit',
        content: diff,
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed' },
    ])
    expect(ok.map((e) => e.type)).toEqual(['tool.started', 'tool.completed', 'diff'])
    expect(ok[2]).toMatchObject({ path: '/w/a.txt', added: 1, removed: 1 })

    const failed = run([
      { sessionUpdate: 'tool_call', toolCallId: 'e2', title: 'Edit', kind: 'edit', content: diff },
      { sessionUpdate: 'tool_call_update', toolCallId: 'e2', status: 'failed' },
    ])
    expect(failed.map((e) => e.type)).toEqual(['tool.started', 'tool.completed'])
    expect(failed[1]).toMatchObject({ ok: false })
  })

  it('counts a file once when an agent spells its path two ways', () => {
    const events = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'g1',
        title: 'search_replace',
        kind: 'edit',
        content: [
          { type: 'diff', path: 'C:/w/proj\\notes.txt', oldText: 'two\n', newText: 'TWO\n' },
          { type: 'diff', path: 'C:\\w\\proj\\notes.txt', oldText: 'two\n', newText: 'TWO\n' },
        ],
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'g1', status: 'completed' },
    ])
    expect(events.filter((e) => e.type === 'diff')).toHaveLength(1)
    expect(events.find((e) => e.type === 'diff')).toMatchObject({ added: 1, removed: 1 })
  })

  it('synthesizes a start for an update that arrives without a tool_call', () => {
    const events = run([
      { sessionUpdate: 'tool_call_update', toolCallId: 'x', title: 'Late', status: 'completed' },
    ])
    expect(events.map((e) => e.type)).toEqual(['tool.started', 'tool.completed'])
    expect(events[0]).toMatchObject({ title: 'Late' })
  })

  it('handles a tool that is already completed in its first message', () => {
    const events = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'r',
        title: 'Read',
        kind: 'read',
        status: 'completed',
        rawOutput: 'text',
      },
    ])
    expect(events).toMatchObject([
      { type: 'tool.started', kind: 'read' },
      { type: 'tool.completed', ok: true, output: 'text' },
    ])
  })

  it('reports mode changes with the known mode list', () => {
    expect(run([{ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }])).toMatchObject([
      {
        type: 'session.modes',
        currentModeId: 'plan',
        modes: [{ id: 'default', label: 'Default' }],
      },
    ])
  })
})
