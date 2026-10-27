import { describe, expect, it } from 'vitest'
import {
  agentToolName,
  agentToolView,
  childActivity,
  childOverlaps,
  childPhase,
  childSessions,
  childrenUsage,
  isAgentTool,
  latestReply,
  looseJson,
} from './agentTools.ts'
import type { SessionView } from './replica.ts'
import type { Tool } from './toolSummary.ts'

const tool = (over: Partial<Tool>): Tool => ({
  kind: 'tool',
  id: 't1',
  title: 'Using beddcode · start_session',
  toolKind: 'other',
  status: 'ok',
  startedAt: 1_000,
  endedAt: 2_000,
  ...over,
})

const session = (over: Partial<SessionView>): SessionView => ({
  id: 'child',
  title: 'Fix tests',
  cwd: '/repo/.wt/fix',
  instanceId: 'codex',
  projectPath: '/repo',
  createdAt: 1_500,
  updatedAt: 9_000,
  status: 'idle',
  items: [],
  added: 0,
  removed: 0,
  turns: 1,
  completedTurns: 1,
  queue: [],
  commands: [],
  config: [],
  parent: { sessionId: 'parent', depth: 1 },
  ...over,
})

describe('agentToolName', () => {
  it('knows the titles Claude, Codex and ACP agents give', () => {
    expect(agentToolName({ title: 'Using beddcode · start_session' })).toBe('start_session')
    expect(agentToolName({ title: 'mcp__beddcode__wait_for' })).toBe('wait_for')
    expect(agentToolName({ title: 'beddcode/read_transcript' })).toBe('read_transcript')
    expect(agentToolName({ title: 'beddcode: list_children' })).toBe('list_children')
  })
  it('takes a bare name only with arguments that fit', () => {
    expect(agentToolName({ title: 'stop', input: '{"session_id":"abc"}' })).toBe('stop')
    expect(agentToolName({ title: 'stop' })).toBeUndefined()
    expect(
      agentToolName({ title: 'start_session', input: '{"agent":"codex","prompt":"hi"}' }),
    ).toBe('start_session')
  })
  it('leaves other tools alone', () => {
    expect(isAgentTool({ title: 'Running Bash: pnpm test' })).toBe(false)
    expect(isAgentTool({ title: 'Using github · create_issue' })).toBe(false)
    expect(isAgentTool({ title: 'Using beddcode · something_else' })).toBe(false)
  })
})

describe('looseJson', () => {
  it('parses whole JSON, arrays as items', () => {
    expect(looseJson('{"a":1}')).toEqual({ a: 1 })
    expect(looseJson('[{"a":1}]')).toEqual({ items: [{ a: 1 }] })
  })
  it('recovers fields from output a provider cut short', () => {
    const cut =
      '{\n  "session_id": "s1",\n  "status": "idle",\n  "done": true,\n  "reply": "Line one\\nLine tw'
    expect(looseJson(cut)).toEqual({
      session_id: 's1',
      status: 'idle',
      done: true,
      reply: 'Line one\nLine tw…',
    })
  })
  it('is empty for nothing or prose', () => {
    expect(looseJson(undefined)).toEqual({})
    expect(looseJson('No agent "x" here')).toEqual({})
  })
})

describe('childPhase and activity', () => {
  it('reads a session view', () => {
    expect(childPhase(session({ status: 'running' }))).toBe('running')
    expect(childPhase(session({ status: 'needs-you' }))).toBe('needs-you')
    expect(childPhase(session({ status: 'failed' }))).toBe('failed')
    expect(childPhase(session({ turns: 0 }))).toBe('starting')
    expect(childPhase(session({ lastTurnReason: 'cancelled' }))).toBe('stopped')
    expect(childPhase(session({}))).toBe('done')
  })
  it('says what a running child does', () => {
    const running = session({
      status: 'running',
      items: [tool({ title: 'Running Bash: pnpm test', toolKind: 'command', status: 'running' })],
    })
    expect(childActivity(running)).toBe('Running $ pnpm test')
    expect(childActivity(session({ status: 'running' }))).toBe('Thinking…')
    expect(childActivity(session({}))).toBeUndefined()
    const asking = session({
      status: 'needs-you',
      items: [
        {
          kind: 'approval',
          id: 'a',
          requestId: 'r',
          title: 'Run rm -rf build',
          options: [],
        },
      ],
    })
    expect(childActivity(asking)).toBe('Asks: Run rm -rf build')
  })
  it('takes the reply since the last user message', () => {
    const s = session({
      items: [
        { kind: 'message', id: '1', role: 'assistant', text: 'old' },
        { kind: 'message', id: '2', role: 'user', text: 'go' },
        { kind: 'message', id: '3', role: 'assistant', text: 'CHILD-' },
        { kind: 'message', id: '4', role: 'assistant', text: 'OK' },
      ],
    })
    expect(latestReply(s)).toBe('CHILD-OK')
  })
})

describe('agentToolView', () => {
  const input = JSON.stringify({ agent: 'codex', prompt: 'Fix the tests', worktree: true })
  it('follows a started child live from its own session', () => {
    const child = session({
      status: 'running',
      branch: 'beddcode/fix',
      worktree: { baseBranch: 'main' },
    })
    const view = agentToolView(
      tool({ input, output: JSON.stringify({ session_id: 'child', agent: 'codex' }) }),
      { parentId: 'parent', sessions: { child } },
    )!
    expect(view.verb).toBe('Started')
    expect(view.prompt).toBe('Fix the tests')
    expect(view.child).toMatchObject({
      id: 'child',
      known: true,
      agent: 'codex',
      title: 'Fix tests',
      branch: 'beddcode/fix',
      worktree: true,
      phase: 'running',
      activity: 'Thinking…',
      startedAt: 1_500,
      endedAt: undefined,
    })
  })
  it('finds the child of a start still under way', () => {
    const child = session({ turns: 0, completedTurns: 0, createdAt: 1_200 })
    const view = agentToolView(tool({ input, status: 'running', output: undefined }), {
      parentId: 'parent',
      sessions: { child, other: session({ id: 'other', parent: undefined }) },
    })!
    expect(view.verb).toBe('Starting')
    expect(view.child?.id).toBe('child')
    expect(view.child?.phase).toBe('starting')
  })
  it('shows why a start failed', () => {
    const view = agentToolView(
      tool({ input, status: 'failed', output: 'No agent "codex" here (see list_agents)' }),
      { parentId: 'parent', sessions: {} },
    )!
    expect(view.error).toContain('No agent')
    expect(view.child?.phase).toBe('failed')
  })
  it('reads wait_for and read_transcript answers', () => {
    const wait = agentToolView(
      tool({
        title: 'Using beddcode · wait_for',
        input: '{"session_id":"child"}',
        output: JSON.stringify({ session_id: 'child', status: 'running', done: false, reply: '' }),
      }),
    )!
    expect(wait.stillWorking).toBe(true)
    expect(wait.child).toMatchObject({ id: 'child', known: false, phase: 'running' })
    const read = agentToolView(
      tool({
        title: 'Using beddcode · read_transcript',
        input: '{"session_id":"child"}',
        output: JSON.stringify({ session_id: 'child', status: 'idle', transcript: 'User: hi' }),
      }),
    )!
    expect(read.transcript).toBe('User: hi')
    expect(read.child?.phase).toBe('done')
  })
  it('keeps what a finished wait saw, even after the child moved on', () => {
    const done = session({ id: 'child', status: 'idle' })
    const seen = agentToolView(
      tool({
        title: 'Using beddcode · wait_for',
        input: '{"session_id":"child"}',
        output: JSON.stringify({ session_id: 'child', status: 'needs-you', done: true }),
      }),
      { sessions: { child: done } },
    )!
    expect(seen.child).toMatchObject({ known: true, phase: 'needs-you', activity: undefined })
  })
  it('lists agents and children', () => {
    const agents = agentToolView(
      tool({
        title: 'Using beddcode · list_agents',
        output: JSON.stringify([
          { agent: 'codex', label: 'Codex' },
          { agent: 'grok', label: 'Grok' },
        ]),
      }),
    )!
    expect(agents.listed?.map((l) => l.label)).toEqual(['Codex', 'Grok'])
    const kids = agentToolView(
      tool({
        title: 'Using beddcode · list_children',
        output: JSON.stringify([
          { session_id: 's', title: 'Fix', agent: 'codex', status: 'needs-you' },
        ]),
      }),
    )!
    expect(kids.listed).toEqual([
      { label: 'Fix', detail: 'codex · Needs your approval', sessionId: 's' },
    ])
  })
  it('is undefined for other tools', () => {
    expect(agentToolView(tool({ title: 'Reading a.ts' }))).toBeUndefined()
  })
})

describe('childSessions', () => {
  it('lists a session’s children oldest first', () => {
    const a = session({ id: 'a', createdAt: 5 })
    const b = session({ id: 'b', createdAt: 2 })
    const c = session({ id: 'c', parent: undefined })
    expect(childSessions('parent', { a, b, c }).map((s) => s.id)).toEqual(['b', 'a'])
  })
})

const changed = (after: string, paths: string[], reverted = false) =>
  ({
    kind: 'changes',
    id: after,
    turnId: 't',
    before: 'b',
    after,
    files: paths.map((path) => ({ path, status: 'M', added: 1, removed: 0 })),
    reverted,
  }) as SessionView['items'][number]

describe('helpers as a group', () => {
  it('adds up what they used', () => {
    expect(childrenUsage([])).toEqual({ tokens: 0, costUsd: 0 })
    expect(
      childrenUsage([
        session({ id: 'a', usage: { tokens: 1200, costUsd: 0.02 } }),
        session({ id: 'b', usage: { tokens: 300, costUsd: 0 } }),
        session({ id: 'c' }),
      ]),
    ).toEqual({ tokens: 1500, costUsd: 0.02 })
  })

  it('finds files two helpers both changed, and ignores undone changes', () => {
    const a = session({ id: 'a', title: 'Add login', items: [changed('1', ['x.ts', 'a.ts'])] })
    const b = session({ id: 'b', title: 'Fix nav', items: [changed('2', ['x.ts'])] })
    const c = session({ id: 'c', title: 'Docs', items: [changed('3', ['README.md'])] })
    expect(childOverlaps([a, b, c])).toEqual({
      a: [{ title: 'Fix nav', files: ['x.ts'] }],
      b: [{ title: 'Add login', files: ['x.ts'] }],
    })
    const undone = session({ ...b, items: [changed('2', ['x.ts'], true)] })
    expect(childOverlaps([a, undone, c])).toEqual({})
  })
})

describe('review_changes and waiting on several', () => {
  it('shows a review as a start of the reviewer, not of the session it reviews', () => {
    const view = agentToolView(
      tool({
        title: 'Using beddcode · review_changes',
        input: '{"session_id":"builder","focus":"tests"}',
        output: JSON.stringify({ session_id: 'reviewer', agent: 'claude', reviewing: 'builder' }),
      }),
    )!
    expect(view).toMatchObject({
      name: 'review_changes',
      verb: 'Started a review of',
      prompt: 'tests',
    })
    expect(view.child).toMatchObject({ id: 'reviewer', agent: 'claude' })
  })

  it('lists the sessions of a wait on several, and whether they were done', () => {
    const view = agentToolView(
      tool({
        title: 'Using beddcode · wait_for',
        input: '{"session_ids":["a","b"],"mode":"all"}',
        output: JSON.stringify({
          done: false,
          sessions: [
            { session_id: 'a', title: 'One', agent: 'codex', status: 'idle', done: true },
            { session_id: 'b', title: 'Two', agent: 'acp:grok', status: 'running', done: false },
          ],
        }),
      }),
    )!
    expect(view.child).toBeUndefined()
    expect(view.stillWorking).toBe(true)
    expect(view.listed).toEqual([
      { label: 'One', detail: 'codex · Done', sessionId: 'a' },
      { label: 'Two', detail: 'acp:grok · Working', sessionId: 'b' },
    ])
  })
})
