import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '@beddcode/contracts'
import { claudeCapabilities } from './adapter.ts'
import { createLogger, createAsyncQueue } from '@beddcode/shared'
import { scanClaudeCommands } from './commands.ts'
import { createClaudeHistory, groupTurns, type ClaudeHistorySdk } from './history.ts'
import { addArgs, createClaudeMcp, parseMcpList } from './mcp.ts'
import { ClaudeEventMapper } from './mapper.ts'
import { ClaudeSession, type QueryFn } from './session.ts'

const log = createLogger('test', 'error')

/** A stand-in for the SDK that the test drives by hand. */
function manualSdk() {
  const calls: [string, unknown][] = []
  const out = createAsyncQueue<SDKMessage>()
  const prompts: SDKUserMessage[] = []
  let options: Options = {}
  const queryFn: QueryFn = ({ prompt, options: o }) => {
    options = o ?? {}
    void (async () => {
      for await (const m of prompt as AsyncIterable<SDKUserMessage>) prompts.push(m)
    })()
    const closeQueue = out.close.bind(out)
    return Object.assign(out, {
      interrupt: async () => {},
      close: () => closeQueue(),
      setPermissionMode: async () => {},
      setModel: async (m?: string) => void calls.push(['setModel', m]),
      applyFlagSettings: async (o: unknown) => void calls.push(['flags', o]),
      supportedCommands: async () => [
        { name: 'review', description: 'Review code', argumentHint: '<pr>' },
        { name: 'compact', description: '', argumentHint: '' },
      ],
    }) as unknown as Query
  }
  const canUse = (tool: string, input: Record<string, unknown>) =>
    (options.canUseTool as CanUseTool)(tool, input, {
      signal: new AbortController().signal,
      toolUseID: 'tu',
      suggestions: [],
    } as never) as Promise<PermissionResult>
  const result = () =>
    out.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
    } as unknown as SDKMessage)
  return { queryFn, out, prompts, canUse, result, calls }
}

function collect(session: ClaudeSession) {
  const events: SessionEvent[] = []
  void (async () => {
    for await (const e of session.events) events.push(e)
  })()
  return events
}
const flush = () => new Promise((r) => setTimeout(r, 15))

function start(sdk: ReturnType<typeof manualSdk>) {
  const session = new ClaudeSession(
    { sessionId: 's1', cwd: '/w' },
    { queryFn: sdk.queryFn, log, modes: claudeCapabilities.permissionModes },
  )
  return { session, events: collect(session) }
}

describe('steering', () => {
  it('sends a message into the running turn with priority "next"', async () => {
    const sdk = manualSdk()
    const { session, events } = start(sdk)
    const turn = session.prompt({ text: 'first' })
    await flush()
    await session.steer({ text: 'also do this' })
    await flush()

    expect(sdk.prompts.map((p) => [p.message.content, p.priority])).toEqual([
      ['first', undefined],
      ['also do this', 'next'],
    ])
    // Steering does not start a second turn.
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1)
    sdk.result()
    await turn
    await session.close()
  })

  it('starts a normal turn when nothing is running', async () => {
    const sdk = manualSdk()
    const { session, events } = start(sdk)
    const turn = session.steer({ text: 'hello' })
    await flush()
    expect(sdk.prompts[0]?.priority).toBeUndefined()
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1)
    sdk.result()
    await turn
    await session.close()
  })
})

describe('plan approval', () => {
  it('shows the plan and offers to approve it, with or without auto-accepting edits', async () => {
    const sdk = manualSdk()
    const { session, events } = start(sdk)
    session.prompt({ text: 'plan it' }).catch(() => {})
    await flush()

    const decision = sdk.canUse('ExitPlanMode', { plan: '1. Do the thing\n2. Test it' })
    await flush()
    const asked = events.find((e) => e.type === 'approval.requested')
    if (asked?.type !== 'approval.requested') throw new Error('no approval')
    expect(asked.plan).toBe('1. Do the thing\n2. Test it')
    expect(asked.options.map((o) => o.id)).toEqual(['allow', 'allow-edits', 'deny'])

    await session.respondToApproval(asked.requestId, 'allow-edits')
    expect(await decision).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
    expect(events.findLast((e) => e.type === 'session.modes')).toMatchObject({
      currentModeId: 'acceptEdits',
    })
    await session.close()
  })

  it('keeps planning when the user declines', async () => {
    const sdk = manualSdk()
    const { session, events } = start(sdk)
    session.prompt({ text: 'plan it' }).catch(() => {})
    await flush()
    const decision = sdk.canUse('ExitPlanMode', { plan: 'x' })
    await flush()
    const asked = events.find((e) => e.type === 'approval.requested')
    if (asked?.type !== 'approval.requested') throw new Error('no approval')
    await session.respondToApproval(asked.requestId, 'deny')
    expect((await decision).behavior).toBe('deny')
    await session.close()
  })
})

describe('questions', () => {
  const input = {
    questions: [
      {
        question: 'Which library should we use?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'zod', description: 'Schema validation' },
          { label: 'valibot', description: 'Smaller' },
        ],
      },
      {
        question: 'Which folders?',
        header: 'Folders',
        multiSelect: true,
        options: [{ label: 'src' }, { label: 'test' }],
      },
    ],
  }

  it('asks the user and returns the answers keyed by question text', async () => {
    const sdk = manualSdk()
    const { session, events } = start(sdk)
    session.prompt({ text: 'go' }).catch(() => {})
    await flush()
    const decision = sdk.canUse('AskUserQuestion', input)
    await flush()

    const asked = events.find((e) => e.type === 'question.requested')
    if (asked?.type !== 'question.requested') throw new Error('no question')
    expect(asked.questions).toMatchObject([
      {
        id: 'q0',
        header: 'Library',
        multiSelect: false,
        options: [{ label: 'zod' }, { label: 'valibot' }],
      },
      { id: 'q1', multiSelect: true },
    ])
    // A question is not a permission prompt.
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false)

    await session.answerQuestion(asked.requestId, { q0: ['zod'], q1: ['src', 'test'] })
    const result = await decision
    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: {
        answers: { 'Which library should we use?': 'zod', 'Which folders?': 'src, test' },
      },
    })
    expect(events.find((e) => e.type === 'question.resolved')).toMatchObject({
      answers: { q0: ['zod'], q1: ['src', 'test'] },
    })
    await session.close()
  })

  it('tells Claude when the question was dismissed', async () => {
    const sdk = manualSdk()
    const { session, events } = start(sdk)
    session.prompt({ text: 'go' }).catch(() => {})
    await flush()
    const decision = sdk.canUse('AskUserQuestion', input)
    await flush()
    const asked = events.find((e) => e.type === 'question.requested')
    if (asked?.type !== 'question.requested') throw new Error('no question')
    await session.answerQuestion(asked.requestId)
    expect((await decision).behavior).toBe('deny')
    await expect(session.answerQuestion(asked.requestId)).rejects.toThrow('No pending question')
    await session.close()
  })

  it('dismisses open questions when the session closes', async () => {
    const sdk = manualSdk()
    const { session, events } = start(sdk)
    session.prompt({ text: 'go' }).catch(() => {})
    await flush()
    const decision = sdk.canUse('AskUserQuestion', input)
    await flush()
    await session.close()
    expect((await decision).behavior).toBe('deny')
    expect(events.find((e) => e.type === 'question.resolved')?.type).toBe('question.resolved')
  })
})

describe('commands and the to-do list', () => {
  it('announces the slash commands Claude reports', async () => {
    const sdk = manualSdk()
    const { session, events } = start(sdk)
    await flush()
    expect(events.find((e) => e.type === 'session.commands')).toMatchObject({
      commands: [
        { name: 'review', description: 'Review code', hint: '<pr>' },
        { name: 'compact', description: undefined, hint: undefined },
      ],
    })
    await session.close()
  })

  it('turns TodoWrite into the plan instead of a tool row', () => {
    const mapper = new ClaudeEventMapper('s1')
    const events = mapper.map({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm1',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
                { content: 'Fix it', status: 'in_progress', activeForm: 'Fixing it' },
                { content: 'Test it', status: 'pending', activeForm: 'Testing it' },
              ],
            },
          },
        ],
      },
    } as unknown as SDKMessage)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'plan.updated',
      steps: [
        { text: 'Read the code', status: 'completed' },
        { text: 'Fixing it', status: 'in-progress' },
        { text: 'Test it', status: 'pending' },
      ],
    })
    const done = mapper.map({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    } as unknown as SDKMessage)
    expect(done).toEqual([])
  })

  it('keeps the agent tool lookups out of the transcript', () => {
    const mapper = new ClaudeEventMapper('s1')
    const started = mapper.map({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm1',
        content: [
          { type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:Foo' } },
        ],
      },
    } as unknown as SDKMessage)
    expect(started).toEqual([])
    expect(
      mapper.map({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      } as unknown as SDKMessage),
    ).toEqual([])
  })

  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

  it('finds custom commands and skills in the user and project folders', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'beddcode-cmds-'))
    dirs.push(root)
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true })
    mkdirSync(path.join(home, '.claude', 'skills', 'pdf'), { recursive: true })
    mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true })
    writeFileSync(
      path.join(home, '.claude', 'commands', 'ship.md'),
      '---\ndescription: "Ship it"\n---\nbody',
    )
    writeFileSync(
      path.join(home, '.claude', 'skills', 'pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: Work with PDFs\n---\n',
    )
    writeFileSync(path.join(project, '.claude', 'commands', 'ship.md'), '# Project ship\nDo it')
    writeFileSync(path.join(project, '.claude', 'commands', 'notes.txt'), 'ignored')

    expect(scanClaudeCommands(project, home)).toEqual([
      { name: 'pdf', description: 'Work with PDFs', kind: 'skill' },
      // The project's command replaces the user's of the same name.
      { name: 'ship', description: 'Project ship', kind: 'command' },
    ])
    expect(scanClaudeCommands(undefined, path.join(root, 'nowhere'))).toEqual([])
  })

  it('reads argument hints from front matter', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'beddcode-cmds-'))
    dirs.push(root)
    mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true })
    writeFileSync(
      path.join(root, '.claude', 'commands', 'fix.md'),
      '---\ndescription: Fix\nargument-hint: [issue-number]\n---\nFix $ARGUMENTS',
    )
    expect(scanClaudeCommands(undefined, root)).toEqual([
      { name: 'fix', description: 'Fix', hint: '[issue-number]', kind: 'command' },
    ])
  })
})

describe('history', () => {
  const msg = (
    type: 'user' | 'assistant',
    uuid: string,
    content: unknown,
    extra: Partial<SessionMessage> = {},
  ): SessionMessage => ({
    type,
    uuid,
    session_id: 's',
    message: { content },
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...extra,
  })
  const transcript: SessionMessage[] = [
    msg('user', 'u1', 'why does it fail?'),
    msg('assistant', 'a1', [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 't', name: 'Read', input: {} },
    ]),
    msg('user', 'u2', [{ type: 'tool_result', tool_use_id: 't', content: 'file text' }]),
    msg('assistant', 'a2', [{ type: 'text', text: 'An off-by-one.' }]),
    msg('assistant', 'sub', [{ type: 'text', text: 'subagent chatter' }], {
      parent_tool_use_id: 'x',
    }),
    msg('user', 'u3', '<command-name>/compact</command-name>'),
    msg('user', 'u4', [{ type: 'text', text: 'fix it' }]),
    msg('assistant', 'a3', [{ type: 'text', text: 'Done.' }]),
  ]

  it('groups a transcript into exchanges, skipping tool results, subagents and command echoes', () => {
    const turns = groupTurns(transcript)
    expect(turns.map(({ user, assistant, lastUuid }) => ({ user, assistant, lastUuid }))).toEqual([
      { user: 'why does it fail?', assistant: 'Let me look.\n\nAn off-by-one.', lastUuid: 'a2' },
      { user: 'fix it', assistant: 'Done.', lastUuid: 'a3' },
    ])
  })

  it('keeps what the agent did, in order, for an imported session', () => {
    const [first, second] = groupTurns(transcript)
    expect(first!.events!.map((e) => e.type)).toEqual([
      'message.delta',
      'tool.started',
      'tool.completed',
      'message.delta',
    ])
    expect(first!.events![1]).toMatchObject({ toolId: 't', kind: 'read' })
    expect(first!.events![2]).toMatchObject({ toolId: 't', ok: true, output: 'file text' })
    expect(second!.events!.map((e) => e.type)).toEqual(['message.delta'])
  })

  it('lists, reads and forks through the SDK', async () => {
    const forkSession = vi.fn(async () => ({ sessionId: 'new-session' }))
    const sdk: ClaudeHistorySdk = {
      listSessions: async () => [
        { sessionId: 'old', summary: 'Older', lastModified: 1 },
        { sessionId: 'new', summary: 'Auto', customTitle: 'Renamed', lastModified: 5, cwd: '/w' },
      ],
      getSessionMessages: async () => transcript,
      forkSession,
    }
    const history = createClaudeHistory(sdk, async () => undefined)
    expect((await history.list('/w')).map((h) => [h.id, h.title])).toEqual([
      ['new', 'Renamed'],
      ['old', 'Older'],
    ])
    expect(await history.read('new', '/w')).toHaveLength(2)

    // Ending after turn 1 cuts the copy at that turn's last message; the whole thing copies everything.
    expect(await history.fork('new', '/w', 1)).toBe('new-session')
    expect(forkSession).toHaveBeenLastCalledWith('new', { dir: '/w', upToMessageId: 'a2' })
    await history.fork('new', '/w', 2)
    expect(forkSession).toHaveBeenLastCalledWith('new', { dir: '/w', upToMessageId: undefined })
    await history.fork('new', '/w')
    expect(forkSession).toHaveBeenLastCalledWith('new', { dir: '/w', upToMessageId: undefined })
    await expect(history.fork('new', '/w', 9)).rejects.toThrow('only 2 turns')
  })
})

describe('MCP through the claude CLI', () => {
  it('parses the listing, including names with spaces and failures', () => {
    const output = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
github: npx -y @modelcontextprotocol/server-github - ✔ Connected
broken: node server.js --flag - ✗ Failed to connect
claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication
legacy: https://example.com/sse (SSE) - ✔ Connected
`
    expect(parseMcpList(output)).toEqual([
      {
        name: 'claude.ai Claude Docs',
        transport: 'http',
        target: 'https://api.anthropic.com/v1/pages/mcp',
        status: 'connected',
      },
      {
        name: 'github',
        transport: 'stdio',
        target: 'npx -y @modelcontextprotocol/server-github',
        status: 'connected',
      },
      {
        name: 'broken',
        transport: 'stdio',
        target: 'node server.js --flag',
        status: 'failed',
        error: 'Failed to connect',
      },
      {
        name: 'claude.ai Notion',
        transport: 'http',
        target: 'https://mcp.notion.com/mcp',
        status: 'needs-auth',
      },
      { name: 'legacy', transport: 'sse', target: 'https://example.com/sse', status: 'connected' },
    ])
  })

  it('builds the CLI arguments for local and remote servers', () => {
    expect(
      addArgs({
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'srv', '/tmp'],
        env: { KEY: 'v' },
        scope: 'project',
      }),
    ).toEqual([
      'mcp',
      'add',
      '--scope',
      'project',
      '-e',
      'KEY=v',
      'fs',
      '--',
      'npx',
      '-y',
      'srv',
      '/tmp',
    ])
    expect(
      addArgs({ name: 'sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp' }),
    ).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'sentry',
      'https://mcp.sentry.dev/mcp',
    ])
    expect(() => addArgs({ name: 'x', transport: 'stdio' })).toThrow('command')
    expect(() => addArgs({ name: 'x', transport: 'sse' })).toThrow('URL')
  })

  it('runs list, add and remove through the CLI and reports its errors', async () => {
    const calls: string[][] = []
    const run = vi.fn(async (_file: string, args: string[]) => {
      calls.push(args)
      return args[1] === 'remove'
        ? { code: 1, stdout: '', stderr: 'No MCP server found with name: nope' }
        : { code: 0, stdout: args[1] === 'list' ? 'a: npx a - ✔ Connected\n' : '', stderr: '' }
    })
    const mcp = createClaudeMcp(() => '/bin/claude', undefined, run)
    expect(await mcp.list('claude', '/w')).toHaveLength(1)
    await mcp.add('claude', { name: 'a', transport: 'stdio', command: 'npx' }, '/w')
    await expect(mcp.remove('claude', 'nope', 'user', '/w')).rejects.toThrow('No MCP server found')
    expect(calls).toEqual([
      ['mcp', 'list'],
      ['mcp', 'add', '--scope', 'user', 'a', '--', 'npx'],
      ['mcp', 'remove', '--scope', 'user', 'nope'],
    ])
    await expect(createClaudeMcp(() => null, undefined, run).list('claude')).rejects.toThrow(
      'not installed',
    )
  })
})

describe('switching models', () => {
  it('changes the live model and sets effort for this process only', async () => {
    const sdk = manualSdk()
    const { session } = start(sdk)
    await session.setModel('opus', 'high')
    expect(sdk.calls).toEqual([
      ['setModel', 'opus'],
      ['flags', { effortLevel: 'high' }],
    ])
    await session.setModel(undefined, undefined)
    expect(sdk.calls.slice(2)).toEqual([['setModel', undefined]])
    await session.close()
  })
})
