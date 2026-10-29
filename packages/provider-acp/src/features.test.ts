import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { SessionEvent } from '@beddcode/contracts'
import { JsonRpcClient, createLogger, type Transport } from '@beddcode/shared'
import { createAcpAdapter, probeEnvironment } from './adapter.ts'
import { AcpAgentStore } from './config.ts'
import { CLIENT_MODES } from './permissions.ts'
import { groupReplay, listAcpSessions, readAcpSession, withAcpAgent } from './history.ts'
import { AcpEventMapper, toConfigOptions } from './mapper.ts'
import { AcpSession } from './session.ts'

const log = createLogger('test', 'error')
type Msg = { id?: number; method?: string; params?: Record<string, unknown> }

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beddcode-acp-f-'))
  dirs.push(d)
  return d
}

/** A scripted ACP agent process; `stderr` is what it printed before it died. */
function agent(handlers: Record<string, (p: Record<string, unknown>) => unknown>, stderr = '') {
  let onLine: (line: string) => void = () => {}
  let onClose: () => void = () => {}
  const received: Msg[] = []
  const waiters: (() => void)[] = []
  const transport: Transport = {
    send(line) {
      const msg = JSON.parse(line) as Msg
      received.push(msg)
      if (msg.id !== undefined && msg.method) {
        const handler = handlers[msg.method]
        queueMicrotask(() => {
          if (!handler)
            return onLine(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32601, message: 'no' },
              }),
            )
          try {
            const result = handler(msg.params ?? {})
            onLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
          } catch (err) {
            const code = (err as { code?: number }).code ?? -32000
            onLine(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code, message: (err as Error).message },
              }),
            )
          }
        })
      }
      waiters.splice(0).forEach((w) => w())
    },
    onLine: (h) => (onLine = h),
    onClose: (h) => (onClose = h),
    close: () => onClose(),
    stderrTail: () => stderr,
  }
  return {
    transport,
    received,
    sent: (m: string) => received.filter((x) => x.method === m),
    update: (update: unknown, sessionId = 'acp-1') =>
      onLine(
        JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }),
      ),
    die: () => onClose(),
    async waitFor(pred: (m: Msg) => boolean): Promise<Msg> {
      for (;;) {
        const found = received.find(pred)
        if (found) return found
        await new Promise<void>((r) => waiters.push(r))
      }
    },
  }
}

const init = (caps: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  initialize: () => ({ protocolVersion: 1, agentCapabilities: caps, ...extra }),
})

const MODEL_OPTION = {
  type: 'select',
  id: 'model',
  name: 'Model',
  category: 'model',
  currentValue: 'fast',
  options: [
    { value: 'fast', name: 'Fast', description: 'Quick' },
    { value: 'smart', name: 'Smart' },
  ],
}

async function nextEvent(session: AcpSession, pred: (e: SessionEvent) => boolean) {
  for await (const e of session.events) if (pred(e)) return e
  throw new Error('stream ended')
}

describe('mapping ACP updates', () => {
  const map = (u: unknown) => new AcpEventMapper('s').map(u as SessionUpdate)

  it("shows the plan, with the agent's own statuses", () => {
    expect(
      map({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read', priority: 'high', status: 'completed' },
          { content: 'Edit', priority: 'high', status: 'in_progress' },
          { content: 'Test', priority: 'low', status: 'pending' },
        ],
      }),
    ).toMatchObject([
      {
        type: 'plan.updated',
        steps: [
          { text: 'Read', status: 'completed' },
          { text: 'Edit', status: 'in-progress' },
          { text: 'Test', status: 'pending' },
        ],
      },
    ])
  })

  it('lists commands with their argument hints', () => {
    expect(
      map({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'web', description: 'Search the web', input: { hint: 'query' } },
          { name: 'clear', description: '' },
        ],
      }),
    ).toMatchObject([
      {
        type: 'session.commands',
        commands: [
          { name: 'web', description: 'Search the web', hint: 'query' },
          { name: 'clear', description: undefined, hint: undefined },
        ],
      },
    ])
  })

  it('adopts a title the agent chooses, ignoring blanks', () => {
    expect(map({ sessionUpdate: 'session_info_update', title: '  Fix the build  ' })).toMatchObject(
      [{ type: 'session.renamed', title: 'Fix the build' }],
    )
    expect(map({ sessionUpdate: 'session_info_update', title: '   ' })).toEqual([])
    expect(map({ sessionUpdate: 'session_info_update' })).toEqual([])
  })

  it('converts select, grouped and boolean config options', () => {
    expect(
      toConfigOptions([
        MODEL_OPTION,
        {
          type: 'select',
          id: 'effort',
          name: 'Thinking',
          category: 'thought_level',
          currentValue: 'low',
          options: [
            {
              group: 'g',
              name: 'Levels',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
        { type: 'boolean', id: 'web', name: 'Web search', currentValue: true },
      ] as never),
    ).toEqual([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        value: 'fast',
        choices: [
          { value: 'fast', name: 'Fast', description: 'Quick' },
          { value: 'smart', name: 'Smart', description: undefined },
        ],
        description: undefined,
      },
      {
        id: 'effort',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        value: 'low',
        description: undefined,
        choices: [
          { value: 'low', name: 'Low', description: undefined, group: 'Levels' },
          { value: 'high', name: 'High', description: undefined, group: 'Levels' },
        ],
      },
      {
        id: 'web',
        name: 'Web search',
        type: 'boolean',
        value: true,
        description: undefined,
        category: undefined,
      },
    ])
    expect(toConfigOptions(null)).toEqual([])
  })
})

describe('AcpSession features', () => {
  const start = (a: ReturnType<typeof agent>) =>
    new AcpSession(
      { sessionId: 's1', cwd: '/w' },
      { transport: a.transport, log, label: 'Test agent' },
    )

  it("announces the agent's settings and changes them on request", async () => {
    const a = agent({
      ...init(),
      'session/new': () => ({ sessionId: 'acp-1', configOptions: [MODEL_OPTION] }),
      'session/set_config_option': (p) => ({
        configOptions: [{ ...MODEL_OPTION, currentValue: p.value }],
      }),
    })
    const session = start(a)
    const first = await nextEvent(session, (e) => e.type === 'session.config')
    expect(first).toMatchObject({ options: [{ id: 'model', value: 'fast' }] })

    const changed = nextEvent(session, (e) => e.type === 'session.config')
    await session.setConfigOption('model', 'smart')
    expect(a.sent('session/set_config_option')[0]?.params).toMatchObject({
      sessionId: 'acp-1',
      configId: 'model',
      value: 'smart',
    })
    expect(await changed).toMatchObject({ options: [{ value: 'smart' }] })

    await session.setConfigOption('web', true)
    expect(a.sent('session/set_config_option')[1]?.params).toMatchObject({
      configId: 'web',
      type: 'boolean',
      value: true,
    })
    await session.close()
  })

  it('sends pictures as image blocks only to agents that accept them', async () => {
    const dir = tmp()
    const png = path.join(dir, 'shot.png')
    const txt = path.join(dir, 'notes.txt')
    writeFileSync(png, Buffer.from([1, 2, 3]))
    writeFileSync(txt, 'hi')

    for (const [images, expected] of [
      [true, ['text', 'image']],
      [false, ['text']],
    ] as const) {
      const a = agent({
        ...init({ promptCapabilities: { image: images } }),
        'session/new': () => ({ sessionId: 'acp-1' }),
        'session/prompt': () => ({ stopReason: 'end_turn' }),
      })
      const session = start(a)
      await session.prompt({ text: 'look', attachments: [png, txt] })
      const blocks = (a.sent('session/prompt')[0]?.params?.prompt ?? []) as {
        type: string
        data?: string
        mimeType?: string
      }[]
      expect(blocks.map((b) => b.type)).toEqual(expected)
      if (images)
        expect(blocks[1]).toMatchObject({
          mimeType: 'image/png',
          data: Buffer.from([1, 2, 3]).toString('base64'),
        })
      await session.close()
    }
  })

  it('tells the user to sign in when the agent refuses to start a session', async () => {
    const a = agent({
      ...init(
        {},
        {
          authMethods: [
            { id: 'oauth', name: 'Google login' },
            { id: 'key', name: 'API key' },
          ],
        },
      ),
      'session/new': () => {
        throw Object.assign(new Error('Authentication required'), { code: -32000 })
      },
    })
    const session = start(a)
    const error = await nextEvent(session, (e) => e.type === 'error')
    expect(error).toMatchObject({
      message: expect.stringContaining('needs you to sign in (Google login or API key)'),
    })
  })

  it('shows the last line the agent printed when it dies', async () => {
    const a = agent(
      { ...init(), 'session/new': () => ({ sessionId: 'acp-1' }) },
      'Loading...\nError: GEMINI_API_KEY is not set',
    )
    const session = start(a)
    await a.waitFor((m) => m.method === 'session/new')
    await new Promise((r) => setTimeout(r, 10))
    const ended = nextEvent(session, (e) => e.type === 'error')
    a.die()
    expect(await ended).toMatchObject({
      message: 'Test agent stopped unexpectedly: Error: GEMINI_API_KEY is not set',
    })
  })
})

describe('JSON-RPC request timeouts', () => {
  it('rejects a request the agent never answers, and ignores a late answer', async () => {
    let onLine: (line: string) => void = () => {}
    const sent: Msg[] = []
    const transport: Transport = {
      send: (line) => void sent.push(JSON.parse(line) as Msg),
      onLine: (h) => (onLine = h),
      onClose: () => {},
      close: () => {},
    }
    const rpc = new JsonRpcClient(transport, log)
    await expect(rpc.request('slow', {}, { timeoutMs: 20 })).rejects.toThrow(
      'slow did not answer within',
    )
    // The late reply is dropped quietly rather than resolving something that already failed.
    expect(() => onLine(JSON.stringify({ id: sent[0]?.id, result: {} }))).not.toThrow()
    // Requests that answer in time are unaffected.
    const quick = rpc.request('quick', {}, { timeoutMs: 1000 })
    onLine(JSON.stringify({ id: sent[1]?.id, result: 'ok' }))
    expect(await quick).toBe('ok')
  })
})

describe('ACP history', () => {
  const chunk = (kind: 'user' | 'agent', text: string) => ({
    sessionUpdate: `${kind}_message_chunk`,
    content: { type: 'text', text },
  })

  it('groups a replay into exchanges, joining chunks', () => {
    expect(
      groupReplay([
        chunk('user', 'why '),
        chunk('user', 'fail?'),
        chunk('agent', 'off by'),
        chunk('agent', ' one'),
        { sessionUpdate: 'tool_call', toolCallId: 't' },
        chunk('user', 'fix it'),
        chunk('agent', 'done'),
        { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } },
      ]),
    ).toEqual([
      { user: 'why fail?', assistant: 'off by one' },
      { user: 'fix it', assistant: 'done' },
    ])
    expect(groupReplay([chunk('agent', 'hello first')])).toEqual([
      { user: '', assistant: 'hello first' },
    ])
    expect(groupReplay([])).toEqual([])
  })

  it('lists sessions across pages, newest first', async () => {
    const pages: Record<string, unknown> = {
      '': {
        sessions: [{ sessionId: 'a', cwd: '/w', title: 'Old', updatedAt: '2026-01-01T00:00:00Z' }],
        nextCursor: 'p2',
      },
      p2: {
        sessions: [{ sessionId: 'b', cwd: '/w', title: '  ', updatedAt: '2026-02-01T00:00:00Z' }],
      },
    }
    const a = agent({
      ...init({ sessionCapabilities: { list: {} } }),
      'session/list': (p) => pages[String(p.cursor ?? '')],
    })
    const items = await withAcpAgent(a.transport, log, 'Agent', (rpc, caps) =>
      listAcpSessions(rpc, caps, 'Agent', '/w'),
    )
    expect(items.map((i) => [i.id, i.title])).toEqual([
      ['b', 'Untitled'],
      ['a', 'Old'],
    ])
    expect(items[0]?.updatedAt).toBe(Date.parse('2026-02-01T00:00:00Z'))
  })

  it('explains agents that cannot list or replay', async () => {
    const none = agent(init())
    await expect(
      withAcpAgent(none.transport, log, 'Agent', (rpc, caps) =>
        listAcpSessions(rpc, caps, 'Agent'),
      ),
    ).rejects.toThrow('does not list')
    const noLoad = agent(init())
    await expect(
      withAcpAgent(noLoad.transport, log, 'Agent', (rpc, caps) =>
        readAcpSession(rpc, caps, 'Agent', 's', '/w'),
      ),
    ).rejects.toThrow('cannot replay')
  })

  it('reads a session by loading it and collecting the replay', async () => {
    const a: ReturnType<typeof agent> = agent({
      ...init({ loadSession: true }),
      // The agent replays the session as updates while it answers session/load.
      'session/load': (p) => {
        a.update(chunk('user', 'hello'), String(p.sessionId))
        a.update(chunk('agent', 'hi there'), String(p.sessionId))
        a.update(chunk('user', 'bye'), 'some-other-session')
        return {}
      },
    })
    const turns = await withAcpAgent(a.transport, log, 'Agent', (rpc, caps) =>
      readAcpSession(rpc, caps, 'Agent', 'sess-9', '/w'),
    )
    expect(turns).toEqual([{ user: 'hello', assistant: 'hi there' }])
    expect(a.sent('session/load')[0]?.params).toMatchObject({
      sessionId: 'sess-9',
      cwd: '/w',
      mcpServers: [],
    })
  })

  it('is offered by the adapter, and an unknown agent is reported', async () => {
    const dir = tmp()
    const store = new AcpAgentStore(path.join(dir, 'acp.json'))
    store.put({ id: 'demo', label: 'Demo', command: process.execPath })
    const a = agent({
      ...init({ sessionCapabilities: { list: {} } }),
      'session/list': () => ({ sessions: [] }),
    })
    const adapter = createAcpAdapter({ store, log, createTransport: () => a.transport })
    expect(adapter.capabilities('acp:demo')).toMatchObject({ history: true, commands: true })
    expect(await adapter.listHistory?.('acp:demo', '/w')).toEqual([])
    await expect(adapter.listHistory?.('acp:nope')).rejects.toThrow('Unknown ACP agent')
  })
})

describe('previewing an agent before a session', () => {
  it('advertises boolean settings support to agents during previews', async () => {
    const dir = tmp()
    const store = new AcpAgentStore(path.join(dir, 'acp.json'))
    store.put({ id: 'demo', label: 'Demo', command: process.execPath })
    let supportsBoolean = false
    const a = agent({
      initialize: (params) => {
        const capabilities = params.clientCapabilities as {
          session?: { configOptions?: { boolean?: unknown } }
        }
        supportsBoolean = capabilities.session?.configOptions?.boolean !== undefined
        return { protocolVersion: 1, agentCapabilities: {} }
      },
      'session/new': () => ({
        sessionId: 'acp-1',
        configOptions: supportsBoolean
          ? [{ type: 'boolean', id: 'web', name: 'Web search', currentValue: true }]
          : [],
      }),
    })
    const adapter = createAcpAdapter({ store, log, createTransport: () => a.transport })
    const preview = await adapter.preview?.('acp:demo', '/w')
    expect(preview?.config).toEqual([
      expect.objectContaining({ id: 'web', type: 'boolean', value: true }),
    ])
  })

  it('rejects unsupported ACP versions during previews', async () => {
    const a = agent({ initialize: () => ({ protocolVersion: 2 }) })
    await expect(withAcpAgent(a.transport, log, 'Demo', async () => {})).rejects.toThrow(
      'Demo speaks ACP v2, which is not supported yet',
    )
  })

  it('reads modes, settings and commands from a throwaway session, then closes it', async () => {
    const dir = tmp()
    const store = new AcpAgentStore(path.join(dir, 'acp.json'))
    store.put({ id: 'demo', label: 'Demo', command: process.execPath })
    const a: ReturnType<typeof agent> = agent({
      ...init({ sessionCapabilities: { close: {} } }),
      'session/new': () => {
        // The command list follows the answer as a notification.
        setTimeout(
          () =>
            a.update({
              sessionUpdate: 'available_commands_update',
              availableCommands: [{ name: 'web', description: 'Search', input: { hint: 'query' } }],
            }),
          10,
        )
        return {
          sessionId: 'acp-1',
          modes: {
            currentModeId: 'ask',
            availableModes: [
              { id: 'ask', name: 'Ask', description: 'Asks first' },
              { id: 'auto', name: 'Auto' },
            ],
          },
          configOptions: [MODEL_OPTION],
        }
      },
      'session/close': () => ({}),
    })
    const adapter = createAcpAdapter({ store, log, createTransport: () => a.transport })
    const preview = await adapter.preview?.('acp:demo', '/w')
    expect(preview).toEqual({
      modes: [
        { id: 'ask', label: 'Ask', description: 'Asks first' },
        { id: 'auto', label: 'Auto', description: undefined },
      ],
      currentModeId: 'ask',
      config: [expect.objectContaining({ id: 'model', value: 'fast' })],
      commands: [{ name: 'web', description: 'Search', hint: 'query', kind: 'command' }],
    })
    expect(a.sent('session/new')[0]?.params).toMatchObject({ cwd: '/w', mcpServers: [] })
    expect(a.sent('session/close')[0]?.params).toMatchObject({ sessionId: 'acp-1' })
  })

  it('copes with an agent that offers nothing', async () => {
    const dir = tmp()
    const store = new AcpAgentStore(path.join(dir, 'acp.json'))
    store.put({ id: 'plain', label: 'Plain', command: process.execPath })
    const a = agent({ ...init(), 'session/new': () => ({ sessionId: 'acp-1' }) })
    const adapter = createAcpAdapter({ store, log, createTransport: () => a.transport })
    expect(await adapter.preview?.('acp:plain')).toEqual({
      // No modes of its own: the app's two choices, so the picker is always there.
      modes: CLIENT_MODES,
      currentModeId: 'ask',
      config: [],
      commands: [],
    })
    expect(a.sent('session/close')).toHaveLength(0)
  })

  it('applies the settings chosen before the session started', async () => {
    const a = agent({
      ...init(),
      'session/new': () => ({ sessionId: 'acp-1', configOptions: [MODEL_OPTION] }),
      'session/set_config_option': (p) => ({
        configOptions: [{ ...MODEL_OPTION, currentValue: p.value }],
      }),
    })
    const session = new AcpSession(
      { sessionId: 's1', cwd: '/w', config: { model: 'smart', web: true } },
      { transport: a.transport, log, label: 'Test agent' },
    )
    await a.waitFor((m) => m.method === 'session/set_config_option' && m.params?.configId === 'web')
    expect(a.sent('session/set_config_option').map((m) => m.params)).toMatchObject([
      { configId: 'model', value: 'smart' },
      { configId: 'web', type: 'boolean', value: true },
    ])
    await session.close()
  })
})

describe('starting Grok', () => {
  const grok = () => {
    const store = new AcpAgentStore(path.join(tmp(), 'acp.json'))
    store.put({ id: 'grok', label: 'Grok', command: 'grok', args: ['agent', 'stdio'] })
    return store
  }

  it('starts it in the chosen mode by flag, and does not have to switch it afterwards', async () => {
    const launches: string[][] = []
    const a = agent({ ...init(), 'session/new': () => ({ sessionId: 'acp-1' }) })
    const adapter = createAcpAdapter({
      store: grok(),
      log,
      createTransport: (config) => {
        launches.push(config.args)
        return a.transport
      },
    })
    const session = await adapter.startSession('acp:grok', {
      sessionId: 's1',
      cwd: '/w',
      permissionMode: 'ask',
    })
    const modes = await nextEvent(session as AcpSession, (e) => e.type === 'session.modes')
    expect(launches).toEqual([['--permission-mode', 'default', 'agent', '--no-leader', 'stdio']])
    expect(modes).toMatchObject({ currentModeId: 'ask' })
    // The flag did the work: no quiet slash command was sent.
    expect(a.sent('session/prompt')).toHaveLength(0)
    await session.close()
  })

  it('looks around with an environment that cannot open a sign-in page', () => {
    expect(probeEnvironment({ A: '1' }, { PATH: '/bin' })).toMatchObject({
      NO_BROWSER: 'true',
      A: '1',
      PATH: '/bin',
    })
    // The agent's own settings still win.
    expect(probeEnvironment({ NO_BROWSER: 'false' }, {}).NO_BROWSER).toBe('false')
  })
})
