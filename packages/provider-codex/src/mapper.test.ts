import { describe, expect, it } from 'vitest'
import { CodexEventMapper, commandTitle, diffForChange, fileChangeTitle } from './mapper.ts'

function mapAll(steps: [string, unknown][], cwd = '/work') {
  const mapper = new CodexEventMapper('s1', cwd, () => 1)
  mapper.setTurn('turn-1')
  return steps.flatMap(([method, params]) => mapper.map(method, params))
}

describe('commandTitle', () => {
  it('unwraps PowerShell and bash wrappers', () => {
    expect(
      commandTitle(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'Get-Content a.txt'`),
    ).toBe('Running Get-Content a.txt')
    expect(commandTitle(`"C:\\p\\pwsh.exe" -Command "ls -la"`)).toBe('Running ls -la')
    expect(commandTitle(`bash -lc 'pnpm test'`)).toBe('Running pnpm test')
    expect(commandTitle('git status')).toBe('Running git status')
  })

  it('shows only the first line of a multi-line command', () => {
    expect(commandTitle('bash -lc "echo a\necho b"')).toBe('Running echo a …')
  })
})

describe('file changes', () => {
  it('titles one or many files relative to the project', () => {
    const one = [{ path: '/work/src/a.ts', kind: { type: 'update' as const }, diff: '' }]
    expect(fileChangeTitle(one, '/work')).toBe('Editing src/a.ts')
    expect(fileChangeTitle([...one, ...one], '/work')).toBe('Editing 2 files')
    expect(fileChangeTitle([{ ...one[0]!, path: '/elsewhere/x.ts' }], '/work')).toBe(
      'Editing /elsewhere/x.ts',
    )
  })

  it('builds diffs for add, delete and update', () => {
    expect(diffForChange({ path: '/work/n.txt', kind: { type: 'add' }, diff: 'a\nb\n' })).toEqual({
      path: '/work/n.txt',
      added: 2,
      removed: 0,
      patch: '+a\n+b',
    })
    expect(diffForChange({ path: 'd', kind: { type: 'delete' }, diff: 'x\n' })).toMatchObject({
      added: 0,
      removed: 1,
    })
    const update = diffForChange(
      {
        path: '/work/f.ts',
        kind: { type: 'update' },
        diff: '--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n',
      },
      '/work',
    )
    expect(update).toMatchObject({ path: 'f.ts', added: 1, removed: 1 })
    expect(update.patch).not.toContain('+++')
  })
})

describe('CodexEventMapper', () => {
  const started = (item: Record<string, unknown>) => ['item/started', { item }] as [string, unknown]
  const completed = (item: Record<string, unknown>) =>
    ['item/completed', { item }] as [string, unknown]

  it('streams agent text and does not repeat it in the final item', () => {
    const events = mapAll([
      ['item/agentMessage/delta', { itemId: 'm1', delta: 'Hel' }],
      ['item/agentMessage/delta', { itemId: 'm1', delta: 'lo' }],
      completed({ type: 'agentMessage', id: 'm1', text: 'Hello' }),
    ])
    expect(events.map((e) => (e.type === 'message.delta' ? e.text : e.type))).toEqual(['Hel', 'lo'])
    expect(events.every((e) => e.turnId === 'turn-1')).toBe(true)
  })

  it('emits the final agent text when nothing was streamed', () => {
    const events = mapAll([completed({ type: 'agentMessage', id: 'm2', text: 'Whole' })])
    expect(events).toMatchObject([{ type: 'message.delta', text: 'Whole' }])
  })

  it('maps a command: started, then completed with success from the exit code', () => {
    const events = mapAll([
      started({ type: 'commandExecution', id: 'c1', command: 'git status' }),
      completed({
        type: 'commandExecution',
        id: 'c1',
        command: 'git status',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: 'clean',
      }),
      completed({
        type: 'commandExecution',
        id: 'c2',
        command: 'false',
        status: 'completed',
        exitCode: 1,
        aggregatedOutput: null,
      }),
      completed({
        type: 'commandExecution',
        id: 'c3',
        command: 'rm x',
        status: 'declined',
        exitCode: null,
      }),
    ])
    expect(events[0]).toMatchObject({
      type: 'tool.started',
      kind: 'command',
      title: 'Running git status',
    })
    expect(events[1]).toMatchObject({
      type: 'tool.completed',
      toolId: 'c1',
      ok: true,
      output: 'clean',
    })
    expect(events[2]).toMatchObject({ toolId: 'c2', ok: false })
    expect(events[3]).toMatchObject({ toolId: 'c3', ok: false })
  })

  it('emits diffs only when the file change was applied', () => {
    const changes = [{ path: '/work/a.txt', kind: { type: 'add' }, diff: 'hi\n' }]
    const ok = mapAll([
      started({ type: 'fileChange', id: 'f1', changes, status: 'inProgress' }),
      completed({ type: 'fileChange', id: 'f1', changes, status: 'completed' }),
    ])
    expect(ok.map((e) => e.type)).toEqual(['tool.started', 'tool.completed', 'diff'])
    expect(ok[0]).toMatchObject({ kind: 'edit', title: 'Editing a.txt' })

    const declined = mapAll([
      completed({ type: 'fileChange', id: 'f2', changes, status: 'declined' }),
    ])
    expect(declined.map((e) => e.type)).toEqual(['tool.completed'])
    expect(declined[0]).toMatchObject({ ok: false })
  })

  it('maps MCP tool calls and ignores reasoning items', () => {
    const events = mapAll([
      started({ type: 'mcpToolCall', id: 't1', server: 'github', tool: 'create_issue' }),
      completed({ type: 'mcpToolCall', id: 't1', status: 'completed', error: null }),
      started({ type: 'reasoning', id: 'r1' }),
      completed({ type: 'reasoning', id: 'r1' }),
    ])
    expect(events).toMatchObject([
      { type: 'tool.started', title: 'Using github · create_issue' },
      { type: 'tool.completed', ok: true },
    ])
  })

  it('maps turn outcomes and retryable errors', () => {
    expect(mapAll([['turn/completed', { turn: { status: 'completed' } }]])).toMatchObject([
      { type: 'turn.completed', reason: 'done' },
    ])
    expect(mapAll([['turn/completed', { turn: { status: 'interrupted' } }]])).toMatchObject([
      { type: 'turn.completed', reason: 'cancelled' },
    ])
    expect(
      mapAll([
        ['turn/completed', { turn: { status: 'failed', error: { message: 'quota exceeded' } } }],
      ]),
    ).toMatchObject([
      { type: 'error', message: 'quota exceeded' },
      { type: 'turn.completed', reason: 'error' },
    ])
    expect(mapAll([['error', { willRetry: true, error: { message: 'blip' } }]])).toEqual([])
    expect(mapAll([['error', { willRetry: false, error: { message: 'fatal' } }]])).toMatchObject([
      { type: 'error', message: 'fatal' },
    ])
  })
})
