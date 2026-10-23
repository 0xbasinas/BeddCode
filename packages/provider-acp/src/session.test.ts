import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { createLogger, type Transport } from '@beddcode/shared'
import { createAcpAdapter } from './adapter.ts'
import { AcpAgentStore } from './config.ts'
import { AcpSession, isChooser } from './session.ts'
import { grokProfile } from './profiles.ts'

type Msg = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  jsonrpc?: string
}

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beddcode-acp-'))
  dirs.push(d)
  return d
}

const MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'plan', name: 'Plan', description: 'Plan first' },
  ],
}

/** An in-memory ACP agent: records client messages, answers setup calls, lets tests drive the rest. */
function fakeAgent(caps: Record<string, unknown> = {}) {
  let lineHandler: (line: string) => void = () => {}
  let closeHandler: () => void = () => {}
  const received: Msg[] = []
  const waiters: (() => void)[] = []
  let nextId = 100
  let closed = false

  const auto: Record<string, (p: Record<string, unknown>) => unknown> = {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, ...caps },
    }),
    'session/new': () => ({ sessionId: 'acp-1', modes: MODES }),
    'session/resume': () => ({ modes: MODES }),
    'session/load': () => ({ modes: MODES }),
    'session/set_mode': () => ({}),
  }

  const transport: Transport = {
    send(line) {
      const msg = JSON.parse(line) as Msg
      received.push(msg)
      if (msg.id !== undefined && msg.method && auto[msg.method]) {
        const result = auto[msg.method]!(msg.params ?? {})
        queueMicrotask(() =>
          lineHandler(
            JSON.stringify(
              result instanceof Error
                ? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: result.message } }
                : result && typeof result === 'object' && 'rpcError' in result
                  ? {
                      jsonrpc: '2.0',
                      id: msg.id,
                      error: (result as { rpcError: unknown }).rpcError,
                    }
                  : { jsonrpc: '2.0', id: msg.id, result },
            ),
          ),
        )
      }
      waiters.splice(0).forEach((w) => w())
    },
    onLine: (h) => (lineHandler = h),
    onClose: (h) => (closeHandler = h),
    close: () => {
      closed = true
      closeHandler()
    },
  }

  const agent = {
    isClosed: () => closed,
    transport,
    received,
    auto,
    sent: (method: string) => received.filter((m) => m.method === method),
    update: (update: unknown, sessionId = 'acp-1') =>
      lineHandler(
        JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }),
      ),
    /** Sends a request to the client and resolves with its reply. */
    ask(method: string, params: unknown): Promise<Msg> {
      const id = nextId++
      lineHandler(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      return agent.waitFor((m) => m.id === id && m.method === undefined)
    },
    reply(promptId: number, result: unknown) {
      lineHandler(JSON.stringify({ jsonrpc: '2.0', id: promptId, result }))
    },
    async waitFor(pred: (m: Msg) => boolean): Promise<Msg> {
      for (;;) {
        const found = received.find(pred)
        if (found) return found
        await new Promise<void>((r) => waiters.push(r))
      }
    },
    die: () => closeHandler(),
  }
  return agent
}

const log = createLogger('test', 'error')
const start = (
  agent: ReturnType<typeof fakeAgent>,
  input: Partial<ConstructorParameters<typeof AcpSession>[0]> = {},
) =>
  new AcpSession(
    { sessionId: 's1', cwd: '/work', ...input },
    { transport: agent.transport, log, label: 'Fake' },
  )

async function nextEvent(session: AcpSession, pred: (e: SessionEvent) => boolean) {
  for await (const e of session.events) if (pred(e)) return e
  throw new Error('stream ended')
}

async function drain(session: AcpSession) {
  await session.close()
  const events: SessionEvent[] = []
  for await (const e of session.events) events.push(e)
  return events
}

/** Starts a prompt and returns the JSON-RPC id of the `session/prompt` request. */
async function beginPrompt(session: AcpSession, agent: ReturnType<typeof fakeAgent>, text = 'go') {
  const turn = session.prompt({ text })
  const request = await agent.waitFor((m) => m.method === 'session/prompt')
  return { turn, promptId: request.id! }
}

describe('AcpSession: setup', () => {
  it('speaks JSON-RPC 2.0, declares fs and terminal support, and opens a session', async () => {
    const agent = fakeAgent()
    const session = start(agent)
    const first = await nextEvent(session, (e) => e.type === 'session.provider-session')
    expect(first).toMatchObject({ providerSessionId: 'acp-1' })

    const init = agent.sent('initialize')[0]!
    expect(init.jsonrpc).toBe('2.0')
    expect(init.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    })
    expect(agent.sent('session/new')[0]?.params).toEqual({ cwd: '/work', mcpServers: [] })
    await session.close()
  })

  it('reports the modes the agent itself offers', async () => {
    const agent = fakeAgent()
    const session = start(agent)
    const modes = await nextEvent(session, (e) => e.type === 'session.modes')
    expect(modes).toMatchObject({
      currentModeId: 'default',
      modes: [
        { id: 'default', label: 'Default' },
        { id: 'plan', label: 'Plan', description: 'Plan first' },
      ],
    })
    await session.close()
  })

  it('applies the requested mode when the agent has it, and ignores unknown ones', async () => {
    const agent = fakeAgent()
    const session = start(agent, { permissionMode: 'plan' })
    const modes = await nextEvent(session, (e) => e.type === 'session.modes')
    expect(modes).toMatchObject({ currentModeId: 'plan' })
    expect(agent.sent('session/set_mode')[0]?.params).toMatchObject({
      sessionId: 'acp-1',
      modeId: 'plan',
    })
    await session.close()

    const other = fakeAgent()
    const s2 = start(other, { permissionMode: 'bogus' })
    expect(await nextEvent(s2, (e) => e.type === 'session.modes')).toMatchObject({
      currentModeId: 'default',
    })
    expect(other.sent('session/set_mode')).toHaveLength(0)
    await s2.close()
  })

  it('resumes with session/resume when the agent supports it', async () => {
    const agent = fakeAgent()
    const session = start(agent, { resumeId: 'old' })
    expect(await nextEvent(session, (e) => e.type === 'session.provider-session')).toMatchObject({
      providerSessionId: 'old',
    })
    expect(agent.sent('session/resume')[0]?.params).toMatchObject({
      sessionId: 'old',
      cwd: '/work',
    })
    expect(agent.sent('session/new')).toHaveLength(0)
    await session.close()
  })

  it('falls back to session/load and drops the replayed history', async () => {
    const agent = fakeAgent({ sessionCapabilities: {} })
    agent.auto['session/load'] = () => {
      // The agent replays old messages before answering; they must not become new events.
      agent.update(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD' } },
        'old',
      )
      return { modes: MODES }
    }
    const session = start(agent, { resumeId: 'old' })
    await nextEvent(session, (e) => e.type === 'session.provider-session')
    expect(agent.sent('session/load')).toHaveLength(1)
    const events = await drain(session)
    expect(events.some((e) => e.type === 'message.delta')).toBe(false)
  })

  it('reports an error when the agent can neither resume nor load', async () => {
    const agent = fakeAgent({ loadSession: false, sessionCapabilities: {} })
    const session = start(agent, { resumeId: 'old' })
    const error = await nextEvent(session, (e) => e.type === 'error')
    expect(error).toMatchObject({ message: 'Fake cannot resume sessions' })
  })

  it('rejects an unsupported protocol version', async () => {
    const agent = fakeAgent()
    agent.auto.initialize = () => ({ protocolVersion: 7 })
    const session = start(agent)
    expect(await nextEvent(session, (e) => e.type === 'error')).toMatchObject({
      message: expect.stringContaining('ACP v7'),
    })
  })
})

describe('AcpSession: turns', () => {
  it('streams text and maps stop reasons', async () => {
    const agent = fakeAgent()
    const session = start(agent)
    const { turn, promptId } = await beginPrompt(session, agent, 'hello')
    expect(agent.sent('session/prompt')[0]?.params).toEqual({
      sessionId: 'acp-1',
      prompt: [{ type: 'text', text: 'hello' }],
    })
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } })
    agent.update(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' there' } },
      'other-session',
    )
    agent.reply(promptId, { stopReason: 'end_turn' })
    await turn

    const events = await drain(session)
    expect(events.filter((e) => e.type === 'message.delta')).toMatchObject([{ text: 'Hi' }])
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'done' })
  })

  it.each([
    ['cancelled', 'cancelled', false],
    ['refusal', 'error', true],
    ['max_tokens', 'error', true],
  ])('maps stopReason %s to %s', async (stopReason, reason, hasError) => {
    const agent = fakeAgent()
    const session = start(agent)
    const { turn, promptId } = await beginPrompt(session, agent)
    agent.reply(promptId, { stopReason })
    await turn
    const events = await drain(session)
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason })
    expect(events.some((e) => e.type === 'error')).toBe(hasError)
  })

  it('finishes the turn with an error when the prompt request fails', async () => {
    const agent = fakeAgent()
    // An error response from the agent, e.g. authentication required.
    agent.auto['session/prompt'] = () => new Error('auth required')
    const session = start(agent)
    const { turn } = await beginPrompt(session, agent)
    await turn
    const events = await drain(session)
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'auth required' })
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'error' })
  })

  it('sends session/cancel on interrupt', async () => {
    const agent = fakeAgent()
    const session = start(agent)
    const { turn, promptId } = await beginPrompt(session, agent)
    await session.interrupt()
    expect(agent.sent('session/cancel')[0]?.params).toEqual({ sessionId: 'acp-1' })
    agent.reply(promptId, { stopReason: 'cancelled' })
    await turn
    await session.close()
  })

  it('switches modes through session/set_mode', async () => {
    const agent = fakeAgent()
    const session = start(agent)
    await session.setPermissionMode('plan')
    expect(agent.sent('session/set_mode').at(-1)?.params).toMatchObject({ modeId: 'plan' })
    await session.close()
  })

  it('ends the turn with an error when the agent process dies mid-turn', async () => {
    const agent = fakeAgent()
    const session = start(agent)
    const { turn } = await beginPrompt(session, agent)
    agent.die()
    await turn
    const events: SessionEvent[] = []
    for await (const e of session.events) events.push(e)
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: 'Fake stopped unexpectedly',
    })
    expect(events.filter((e) => e.type === 'turn.completed')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'error' })
  })

  it('does not throw from prompt when start-up failed (the error event already says why)', async () => {
    const agent = fakeAgent()
    agent.auto.initialize = () => ({ protocolVersion: 9 })
    const session = start(agent)
    await expect(session.prompt({ text: 'hi' })).resolves.toBeUndefined()
  })
})

describe('AcpSession: permissions', () => {
  const permission = {
    sessionId: 'acp-1',
    toolCall: {
      toolCallId: 't1',
      title: 'Edit notes.txt',
      rawInput: { file_path: '/w/notes.txt' },
    },
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  }

  it("shows the agent's own options and returns the chosen option id", async () => {
    const agent = fakeAgent()
    const session = start(agent)
    const reply = agent.ask('session/request_permission', permission)
    const request = await nextEvent(session, (e) => e.type === 'approval.requested')
    if (request.type !== 'approval.requested') throw new Error('unreachable')
    expect(request).toMatchObject({
      title: 'Edit notes.txt',
      detail: '/w/notes.txt',
      toolId: 't1',
    })
    expect(request.options).toEqual([
      { id: 'once', label: 'Allow once', kind: 'allow' },
      { id: 'always', label: 'Always allow', kind: 'allow' },
      { id: 'no', label: 'Reject', kind: 'deny' },
    ])

    await session.respondToApproval(request.requestId, 'always')
    expect((await reply).result).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    await session.close()
  })

  it('answers open requests with "cancelled" on interrupt', async () => {
    const agent = fakeAgent()
    const session = start(agent)
    const reply = agent.ask('session/request_permission', permission)
    await nextEvent(session, (e) => e.type === 'approval.requested')
    await session.interrupt()
    expect((await reply).result).toEqual({ outcome: { outcome: 'cancelled' } })
    await session.close()
  })
})

describe('AcpSession: client methods', () => {
  it('reads and writes files at absolute paths, including line ranges', async () => {
    const dir = tmp()
    const file = path.join(dir, 'sub', 'a.txt')
    const agent = fakeAgent()
    const session = start(agent)

    const written = await agent.ask('fs/write_text_file', {
      sessionId: 'acp-1',
      path: file,
      content: 'l1\nl2\nl3\nl4',
    })
    expect(written.result).toEqual({})
    expect(readFileSync(file, 'utf8')).toBe('l1\nl2\nl3\nl4')
    const whole = await agent.ask('fs/read_text_file', { sessionId: 'acp-1', path: file })
    expect(whole.result).toEqual({ content: 'l1\nl2\nl3\nl4' })
    const part = await agent.ask('fs/read_text_file', {
      sessionId: 'acp-1',
      path: file,
      line: 2,
      limit: 2,
    })
    expect(part.result).toEqual({ content: 'l2\nl3' })
    await session.close()
  })

  it('refuses relative paths and unknown methods', async () => {
    const agent = fakeAgent()
    const session = start(agent)
    const rel = (await agent.ask('fs/read_text_file', {
      sessionId: 'acp-1',
      path: 'relative.txt',
    })) as { error?: { code: number } }
    expect(rel.error?.code).toBe(-32602)
    const unknown = (await agent.ask('nope/nothing', {})) as { error?: { code: number } }
    expect(unknown.error?.code).toBe(-32601)
    await session.close()
  })

  it('runs a terminal command and reports output and exit status', async () => {
    const agent = fakeAgent()
    const session = start(agent, { cwd: tmp() })
    const created = await agent.ask('terminal/create', {
      sessionId: 'acp-1',
      command: process.execPath,
      args: ['-e', 'console.log("hello from terminal"); process.exit(3)'],
    })
    const { terminalId } = created.result as { terminalId: string }

    const exit = await agent.ask('terminal/wait_for_exit', { sessionId: 'acp-1', terminalId })
    expect(exit.result).toMatchObject({ exitCode: 3 })
    const out = await agent.ask('terminal/output', { sessionId: 'acp-1', terminalId })
    expect(out.result).toMatchObject({
      output: expect.stringContaining('hello from terminal'),
      truncated: false,
      exitStatus: { exitCode: 3 },
    })

    await agent.ask('terminal/release', { sessionId: 'acp-1', terminalId })
    const gone = (await agent.ask('terminal/output', { sessionId: 'acp-1', terminalId })) as {
      error?: unknown
    }
    expect(gone.error).toBeDefined()
    await session.close()
  })

  it('truncates terminal output from the front when a byte limit is set', async () => {
    const agent = fakeAgent()
    const session = start(agent, { cwd: tmp() })
    const { terminalId } = (
      await agent.ask('terminal/create', {
        sessionId: 'acp-1',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("0123456789ABCDEF")'],
        outputByteLimit: 6,
      })
    ).result as { terminalId: string }
    await agent.ask('terminal/wait_for_exit', { sessionId: 'acp-1', terminalId })
    expect(
      (await agent.ask('terminal/output', { sessionId: 'acp-1', terminalId })).result,
    ).toMatchObject({
      output: 'ABCDEF',
      truncated: true,
    })
    await session.close()
  })

  it('kills a running terminal', async () => {
    const agent = fakeAgent()
    const session = start(agent, { cwd: tmp() })
    const { terminalId } = (
      await agent.ask('terminal/create', {
        sessionId: 'acp-1',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      })
    ).result as { terminalId: string }
    await agent.ask('terminal/kill', { sessionId: 'acp-1', terminalId })
    const exit = await agent.ask('terminal/wait_for_exit', { sessionId: 'acp-1', terminalId })
    expect(exit.result).toBeDefined()
    await session.close()
  })
})

describe('createAcpAdapter', () => {
  it('generates text with the chosen ACP instance in a separate session and closes it', async () => {
    const dir = tmp()
    const store = new AcpAgentStore(path.join(dir, 'agents.json'))
    store.put({ id: 'first', label: 'First', command: process.execPath })
    store.put({ id: 'second', label: 'Second', command: process.execPath })
    const agent = fakeAgent({ sessionCapabilities: { close: {} } })
    agent.auto['session/close'] = () => ({})
    agent.auto['session/prompt'] = () => {
      agent.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '{"message":"fix: ' },
      })
      agent.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'align Git controls"}' },
      })
      return { stopReason: 'end_turn' }
    }
    let chosen = ''
    const adapter = createAcpAdapter({
      store,
      log,
      createTransport: (config, cwd) => {
        chosen = config.id
        expect(cwd).toBe(dir)
        return agent.transport
      },
    })
    expect((await adapter.detect())[1]?.capabilities.textGeneration).toBe(true)
    expect(
      await adapter.generateText!({
        instanceId: 'acp:second',
        cwd: dir,
        prompt: 'Draft JSON only',
      }),
    ).toBe('{"message":"fix: align Git controls"}')
    expect(chosen).toBe('second')
    expect(agent.sent('initialize')[0]?.params?.clientCapabilities).toEqual({})
    expect(agent.sent('session/new')[0]?.params).toMatchObject({ cwd: dir, mcpServers: [] })
    expect(agent.sent('session/prompt')).toHaveLength(1)
    expect(agent.sent('session/close')).toHaveLength(1)
    expect(agent.isClosed()).toBe(true)
  })

  it('returns ACP authentication failures and closes the generation process', async () => {
    const dir = tmp()
    const store = new AcpAgentStore(path.join(dir, 'agents.json'))
    store.put({ id: 'here', label: 'Here', command: process.execPath })
    const agent = fakeAgent()
    agent.auto['session/new'] = () => new Error('Sign in to this agent first')
    const adapter = createAcpAdapter({ store, log, createTransport: () => agent.transport })
    await expect(
      adapter.generateText!({ instanceId: 'acp:here', cwd: dir, prompt: 'Draft JSON' }),
    ).rejects.toThrow('Sign in')
    expect(agent.isClosed()).toBe(true)
  })
  it('lists configured agents with install status and starts sessions through the transport', async () => {
    const dir = tmp()
    const store = new AcpAgentStore(path.join(dir, 'agents.json'))
    store.put({ id: 'here', label: 'Here', command: process.execPath })
    store.put({ id: 'gone', label: 'Gone', command: 'definitely-not-installed-xyz' })

    const agent = fakeAgent()
    const adapter = createAcpAdapter({ store, log, createTransport: () => agent.transport })

    const instances = await adapter.detect()
    expect(instances.map((i) => [i.id, i.kind, i.status])).toEqual([
      ['acp:here', 'acp', 'ready'],
      ['acp:gone', 'acp', 'not-installed'],
    ])

    const session = await adapter.startSession('acp:here', { sessionId: 's9', cwd: dir })
    expect(
      await nextEvent(session as AcpSession, (e) => e.type === 'session.provider-session'),
    ).toMatchObject({
      providerSessionId: 'acp-1',
    })
    await session.close()
    await expect(adapter.startSession('acp:nope', { sessionId: 's', cwd: dir })).rejects.toThrow(
      'Unknown ACP agent',
    )
    writeFileSync(path.join(dir, 'unused'), '')
  })
})

describe('AcpSession: text generation', () => {
  it('declines permissions, files, terminals and questions without performing their actions', async () => {
    const agent = fakeAgent()
    const dir = tmp()
    const file = path.join(dir, 'keep.txt')
    const marker = path.join(dir, 'terminal-marker.txt')
    writeFileSync(file, 'keep this content')
    const session = start(agent, { cwd: dir, textOnly: true, permissionMode: 'approve-all' })
    await nextEvent(session, (e) => e.type === 'session.modes')
    const permission = await agent.ask('session/request_permission', {
      sessionId: 'acp-1',
      toolCall: { toolCallId: 't1', title: 'Write' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    })
    expect(permission.result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(await agent.ask('fs/read_text_file', { path: file })).toHaveProperty('error')
    expect(
      await agent.ask('fs/write_text_file', { path: file, content: 'replaced' }),
    ).toHaveProperty('error')
    expect(
      await agent.ask('terminal/create', { command: `echo changed > "${marker}"` }),
    ).toHaveProperty('error')
    expect((await agent.ask('elicitation/create', { mode: 'form' })).result).toEqual({
      action: 'decline',
    })
    expect(readFileSync(file, 'utf8')).toBe('keep this content')
    expect(existsSync(marker)).toBe(false)
    const events = await drain(session)
    expect(
      events.filter((e) => e.type === 'question.requested' || e.type === 'approval.requested'),
    ).toEqual([])
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })

  it('selects a read-only mode and applies the saved model when the agent offers them', async () => {
    const agent = fakeAgent()
    agent.auto['session/new'] = () => ({
      sessionId: 'acp-1',
      modes: {
        currentModeId: 'auto',
        availableModes: [
          { id: 'auto', name: 'Auto' },
          { id: 'read-only', name: 'Read only' },
        ],
      },
      models: {
        currentModelId: 'old',
        availableModels: [
          { modelId: 'old', name: 'Old' },
          { modelId: 'chosen', name: 'Chosen' },
        ],
      },
    })
    agent.auto['session/set_model'] = () => ({})
    const session = start(agent, { textOnly: true, model: 'chosen' })
    const { turn, promptId } = await beginPrompt(session, agent)
    expect(agent.sent('session/set_mode')[0]?.params).toMatchObject({ modeId: 'read-only' })
    expect(agent.sent('session/set_model')[0]?.params).toMatchObject({ modelId: 'chosen' })
    agent.reply(promptId, { stopReason: 'end_turn' })
    await turn
    await session.close()
  })
})

describe('AcpSession: approval modes', () => {
  const MODE_OPTION = {
    id: 'mode',
    name: 'Session Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'ask',
    options: [
      { value: 'ask', name: 'Ask' },
      { value: 'code', name: 'Code' },
    ],
  }
  const MODEL_OPTION = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'm1',
    options: [{ value: 'm1', name: 'M1' }],
  }
  const permission = {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1', title: 'Run ls', rawInput: { command: 'ls' } },
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  }

  it("uses the agent's mode option, sends changes through it, and keeps it out of the settings", async () => {
    const agent = fakeAgent()
    agent.auto['session/new'] = () => ({
      sessionId: 'acp-1',
      configOptions: [MODEL_OPTION, MODE_OPTION],
    })
    agent.auto['session/set_config_option'] = (p) => ({
      configOptions: [MODEL_OPTION, { ...MODE_OPTION, currentValue: p.value }],
    })
    const session = start(agent, { permissionMode: 'code' })
    const events: SessionEvent[] = []
    for await (const e of session.events) {
      events.push(e)
      if (e.type === 'session.config') break
    }
    expect(agent.sent('session/set_mode')).toHaveLength(0)
    expect(agent.sent('session/set_config_option')[0]?.params).toMatchObject({
      configId: 'mode',
      value: 'code',
    })
    const modes = events.findLast((e) => e.type === 'session.modes')
    expect(modes).toMatchObject({ currentModeId: 'code', modes: [{ id: 'ask' }, { id: 'code' }] })
    const config = events.findLast((e) => e.type === 'session.config')
    expect(config).toMatchObject({ options: [{ id: 'model' }] })
    await session.close()
  })

  it('follows the agent when it changes its own mode', async () => {
    const agent = fakeAgent()
    agent.auto['session/new'] = () => ({ sessionId: 'acp-1', configOptions: [MODE_OPTION] })
    const session = start(agent)
    await nextEvent(session, (e) => e.type === 'session.modes')
    agent.update({
      sessionUpdate: 'config_option_update',
      configOptions: [{ ...MODE_OPTION, currentValue: 'code' }],
    })
    expect(await nextEvent(session, (e) => e.type === 'session.modes')).toMatchObject({
      currentModeId: 'code',
    })
    await session.close()
  })

  it('offers asking or approving everything when the agent has no modes, switchable mid-session', async () => {
    const agent = fakeAgent()
    agent.auto['session/new'] = () => ({ sessionId: 'acp-1' })
    const session = start(agent)
    expect(await nextEvent(session, (e) => e.type === 'session.modes')).toMatchObject({
      currentModeId: 'ask',
      modes: [{ id: 'ask' }, { id: 'approve-all', dangerous: true }],
    })

    // Asking: the request is shown and waits for the user.
    const first = agent.ask('session/request_permission', permission)
    const shown = await nextEvent(session, (e) => e.type === 'approval.requested')
    if (shown.type !== 'approval.requested') throw new Error('unreachable')
    await session.respondToApproval(shown.requestId, 'no')
    expect((await first).result).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })

    // Approving everything: answered at once with allow-once, never touching the agent's own modes.
    await session.setPermissionMode('approve-all')
    const second = await agent.ask('session/request_permission', {
      ...permission,
      toolCall: { toolCallId: 't2', title: 'Run pwd' },
    })
    expect(second.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(agent.sent('session/set_mode')).toHaveLength(0)
    expect(agent.sent('session/set_config_option')).toHaveLength(0)

    // And back to asking.
    await session.setPermissionMode('ask')
    const third = agent.ask('session/request_permission', permission)
    await nextEvent(session, (e) => e.type === 'approval.requested')
    await session.interrupt()
    expect((await third).result).toEqual({ outcome: { outcome: 'cancelled' } })
    await session.close()
  })

  it('can start out approving everything, and still asks when there is nothing to allow with', async () => {
    const agent = fakeAgent()
    agent.auto['session/new'] = () => ({ sessionId: 'acp-1' })
    const session = start(agent, { permissionMode: 'approve-all' })
    expect(await nextEvent(session, (e) => e.type === 'session.modes')).toMatchObject({
      currentModeId: 'approve-all',
    })
    const reply = await agent.ask('session/request_permission', permission)
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })

    const pending = agent.ask('session/request_permission', {
      ...permission,
      options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }],
    })
    await nextEvent(session, (e) => e.type === 'approval.requested')
    await session.interrupt()
    expect((await pending).result).toEqual({ outcome: { outcome: 'cancelled' } })
    await session.close()
  })

  it('switches a known agent with its own slash command, quietly, from the setting it starts with', async () => {
    const agent = fakeAgent()
    agent.auto['session/new'] = () => ({ sessionId: 'acp-1' })
    // The agent answers its own slash command in prose.
    agent.auto['session/prompt'] = () => {
      agent.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'always-approve changed' },
      })
      return { stopReason: 'end_turn' }
    }
    const profile = grokProfile(() => '[ui]\npermission_mode = "always-approve"\n')
    const session = new AcpSession(
      { sessionId: 's1', cwd: '/work', permissionMode: 'ask' },
      { transport: agent.transport, log, label: 'Fake', profile },
    )
    const events: SessionEvent[] = []
    const watch = (async () => {
      for await (const e of session.events) events.push(e)
    })()
    // Starts out always-approve by its own config; the user asked to ask, so it is told so.
    await agent.waitFor((m) => m.method === 'session/prompt')
    expect(agent.sent('session/prompt')[0]?.params).toMatchObject({
      prompt: [{ type: 'text', text: '/always-approve off' }],
    })
    await session.setPermissionMode('approve-all')
    expect(agent.sent('session/prompt').at(-1)?.params).toMatchObject({
      prompt: [{ type: 'text', text: '/always-approve on' }],
    })
    await session.close()
    await watch
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(0)
    // That reply is not shown, and no turn is reported.
    expect(events.some((e) => e.type === 'message.delta')).toBe(false)
    const modes = events.filter((e) => e.type === 'session.modes')
    expect(modes[0]).toMatchObject({
      currentModeId: 'ask',
      modes: [{ id: 'ask' }, { id: 'approve-all' }],
    })
    expect(modes.at(-1)).toMatchObject({ currentModeId: 'approve-all' })
  })
})

describe('AcpSession: a turn that never answers', () => {
  const timing = {
    BEDDCODE_ACP_IDLE_MS: '120',
    BEDDCODE_ACP_CHECK_MS: '15',
    BEDDCODE_ACP_CANCEL_GRACE_MS: '40',
  }
  const withTiming = async (fn: () => Promise<void>) => {
    const before = { ...process.env }
    Object.assign(process.env, timing)
    try {
      await fn()
    } finally {
      for (const key of Object.keys(timing)) {
        if (before[key] === undefined) delete process.env[key]
        else process.env[key] = before[key]
      }
    }
  }
  const collect = (session: AcpSession) => {
    const events: SessionEvent[] = []
    void (async () => {
      for await (const e of session.events) events.push(e)
    })()
    return events
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('is cancelled and then ended when the agent goes silent', async () => {
    await withTiming(async () => {
      const agent = fakeAgent()
      const session = start(agent)
      const events = collect(session)
      await session.prompt({ text: 'go' })
      expect(agent.sent('session/cancel')).toHaveLength(1)
      expect(events.find((e) => e.type === 'error')).toMatchObject({
        message: expect.stringContaining('stopped responding'),
      })
      expect(events.filter((e) => e.type === 'turn.completed')).toMatchObject([{ reason: 'error' }])
      await session.close()
    })
  })

  it('is left alone while the agent keeps showing signs of work', async () => {
    await withTiming(async () => {
      const agent = fakeAgent()
      const session = start(agent)
      const events = collect(session)
      const turn = session.prompt({ text: 'go' })
      const promptId = (await agent.waitFor((m) => m.method === 'session/prompt')).id as number
      for (let i = 0; i < 12; i++) {
        agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } })
        await sleep(30)
      }
      expect(events.some((e) => e.type === 'error')).toBe(false)
      agent.reply(promptId, { stopReason: 'end_turn' })
      await turn
      expect(events.filter((e) => e.type === 'turn.completed')).toMatchObject([{ reason: 'done' }])
      await session.close()
    })
  })

  it('does not count the time it waits for the user', async () => {
    await withTiming(async () => {
      const agent = fakeAgent()
      const session = start(agent)
      const events = collect(session)
      const turn = session.prompt({ text: 'go' })
      const promptId = (await agent.waitFor((m) => m.method === 'session/prompt')).id as number
      const asked = agent.ask('session/request_permission', {
        sessionId: 'acp-1',
        toolCall: { toolCallId: 't1', title: 'Run it' },
        options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
      })
      await sleep(400)
      expect(events.some((e) => e.type === 'error')).toBe(false)
      const request = events.find((e) => e.type === 'approval.requested')
      if (request?.type !== 'approval.requested') throw new Error('no approval')
      await session.respondToApproval(request.requestId, 'ok')
      await asked
      agent.reply(promptId, { stopReason: 'end_turn' })
      await turn
      expect(events.some((e) => e.type === 'error')).toBe(false)
      await session.close()
    })
  })

  it('is ended as cancelled when the agent ignores a cancel', async () => {
    await withTiming(async () => {
      const agent = fakeAgent()
      const session = start(agent)
      const events = collect(session)
      const turn = session.prompt({ text: 'go' })
      await agent.waitFor((m) => m.method === 'session/prompt')
      await session.interrupt()
      await turn
      expect(events.filter((e) => e.type === 'turn.completed')).toMatchObject([
        { reason: 'cancelled' },
      ])
      await session.close()
    })
  })
})

describe('AcpSession: forms and questions', () => {
  const form = {
    sessionId: 'acp-1',
    mode: 'form',
    message: 'Where to?',
    requestedSchema: {
      type: 'object',
      properties: {
        env: {
          type: 'string',
          title: 'Environment',
          oneOf: [
            { const: 'stg', title: 'Staging' },
            { const: 'prod', title: 'Production' },
          ],
        },
      },
    },
  }

  it('shows an elicitation form as a question and answers with the values the agent defined', async () => {
    const agent = fakeAgent()
    const session = start(agent)
    const reply = agent.ask('elicitation/create', form)
    const asked = await nextEvent(session, (e) => e.type === 'question.requested')
    if (asked.type !== 'question.requested') throw new Error('unreachable')
    expect(asked.questions).toMatchObject([
      {
        id: 'env',
        question: 'Where to?',
        options: [{ label: 'Staging' }, { label: 'Production' }],
      },
    ])
    await session.answerQuestion?.(asked.requestId, { env: ['Production'] })
    expect((await reply).result).toEqual({ action: 'accept', content: { env: 'prod' } })
    await session.close()
  })

  it('declines a form it cannot show, and one that is dismissed', async () => {
    const agent = fakeAgent()
    const session = start(agent)
    expect(
      (await agent.ask('elicitation/create', { sessionId: 'acp-1', mode: 'url', message: 'x' }))
        .result,
    ).toEqual({ action: 'decline' })
    const reply = agent.ask('elicitation/create', form)
    await nextEvent(session, (e) => e.type === 'question.requested')
    await session.interrupt()
    expect((await reply).result).toEqual({ action: 'decline' })
    await session.close()
  })

  it("answers Grok's own question request in the shape it expects", async () => {
    const agent = fakeAgent()
    const session = start(agent)
    const reply = agent.ask('_x.ai/ask_user_question', {
      sessionId: 'acp-1',
      toolCallId: 't1',
      questions: [
        { question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      ],
    })
    const asked = await nextEvent(session, (e) => e.type === 'question.requested')
    if (asked.type !== 'question.requested') throw new Error('unreachable')
    await session.answerQuestion?.(asked.requestId, { q0: ['SQLite'] })
    expect((await reply).result).toEqual({
      outcome: 'accepted',
      answers: { 'Which database?': ['SQLite'] },
      annotations: {},
    })
    await session.close()
  })

  it("hands Grok's finished plan to the user, and tells it what they decided", async () => {
    const agent = fakeAgent()
    const session = start(agent)
    const first = agent.ask('_x.ai/exit_plan_mode', {
      sessionId: 'acp-1',
      toolCallId: 't1',
      planContent: '# Plan\n- one',
    })
    const request = await nextEvent(session, (e) => e.type === 'approval.requested')
    if (request.type !== 'approval.requested') throw new Error('unreachable')
    expect(request).toMatchObject({ title: 'Plan ready for review', plan: '# Plan\n- one' })
    expect(request.options.map((o) => o.id)).toEqual(['approve', 'revise'])
    await session.respondToApproval(request.requestId, 'approve')
    expect((await first).result).toEqual({ outcome: 'approved' })

    const second = agent.ask('x.ai/exit_plan_mode', {
      sessionId: 'acp-1',
      toolCallId: 't2',
      planContent: '# Plan 2',
    })
    const again = await nextEvent(
      session,
      (e) => e.type === 'approval.requested' && e.plan === '# Plan 2',
    )
    if (again.type !== 'approval.requested') throw new Error('unreachable')
    await session.respondToApproval(again.requestId, 'revise')
    expect((await second).result).toMatchObject({
      outcome: 'cancelled',
      feedback: expect.stringContaining('keep planning'),
    })
    await session.close()
  })
})

describe('AcpSession: models outside the config options', () => {
  const MODELS = {
    currentModelId: 'm1',
    availableModels: [
      { modelId: 'm1', name: 'Model 1' },
      { modelId: 'm2', name: 'Model 2' },
    ],
  }

  it('shows them as a model setting and changes it with session/set_model', async () => {
    const agent = fakeAgent()
    agent.auto['session/new'] = () => ({ sessionId: 'acp-1', models: MODELS })
    agent.auto['session/set_model'] = () => ({})
    const session = start(agent)
    const config = await nextEvent(session, (e) => e.type === 'session.config')
    expect(config).toMatchObject({
      options: [
        {
          id: 'model',
          category: 'model',
          value: 'm1',
          choices: [{ value: 'm1' }, { value: 'm2' }],
        },
      ],
    })
    await session.setConfigOption?.('model', 'm2')
    expect(agent.sent('session/set_model')[0]?.params).toMatchObject({
      sessionId: 'acp-1',
      modelId: 'm2',
    })
    expect(await nextEvent(session, (e) => e.type === 'session.config')).toMatchObject({
      options: [{ id: 'model', value: 'm2' }],
    })
    await session.close()
  })

  it("leaves the agent's own model option alone", async () => {
    const agent = fakeAgent()
    agent.auto['session/new'] = () => ({
      sessionId: 'acp-1',
      models: MODELS,
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'x',
          options: [{ value: 'x', name: 'X' }],
        },
      ],
    })
    const session = start(agent)
    const config = await nextEvent(session, (e) => e.type === 'session.config')
    if (config.type !== 'session.config') throw new Error('unreachable')
    expect(config.options).toHaveLength(1)
    expect(config.options[0]).toMatchObject({ value: 'x' })
    await session.close()
  })
})

describe('AcpSession: starting and resuming', () => {
  it("tries again when the agent's session storage is not ready yet", async () => {
    const agent = fakeAgent()
    let calls = 0
    agent.auto['session/new'] = () =>
      ++calls < 3
        ? { rpcError: { code: -32000, message: 'Internal error', data: { code: 'FS_NOT_FOUND' } } }
        : { sessionId: 'acp-1' }
    const session = start(agent)
    await nextEvent(session, (e) => e.type === 'session.modes')
    expect(calls).toBe(3)
    await session.close()
  })

  it("reports the agent's own reason when it refuses", async () => {
    const agent = fakeAgent()
    agent.auto['session/new'] = () => ({
      rpcError: { code: -32603, message: 'Internal error', data: { details: 'quota exceeded' } },
    })
    const session = start(agent)
    const failed = await nextEvent(session, (e) => e.type === 'error')
    expect(failed).toMatchObject({ message: 'Internal error: quota exceeded' })
    await session.close()
  })

  it('keeps a replay that arrives after the load has answered out of the transcript', async () => {
    const agent = fakeAgent({ sessionCapabilities: {} })
    agent.auto['session/load'] = () => {
      // The agent answers, then replays the conversation a moment later.
      setTimeout(
        () =>
          agent.update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'old words' },
          }),
        40,
      )
      setTimeout(
        () =>
          agent.update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'more old words' },
          }),
        90,
      )
      return { modes: MODES }
    }
    const session = start(agent, { resumeId: 'acp-1' })
    const events: SessionEvent[] = []
    void (async () => {
      for await (const e of session.events) events.push(e)
    })()
    await nextEventFrom(events, (e) => e.type === 'session.modes')
    // Live words after the replay is over are shown.
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh' } })
    await new Promise((r) => setTimeout(r, 30))
    const words = events
      .filter((e) => e.type === 'message.delta')
      .map((e) => (e as { text: string }).text)
    expect(words).toEqual(['fresh'])
    await session.close()
  })
})

describe('permission choosers', () => {
  it('knows a request that offers several allow choices of one kind', () => {
    expect(
      isChooser([{ kind: 'allow_once' }, { kind: 'allow_once' }, { kind: 'reject_once' }]),
    ).toBe(true)
    expect(
      isChooser([{ kind: 'allow_once' }, { kind: 'allow_always' }, { kind: 'reject_once' }]),
    ).toBe(false)
    expect(isChooser([])).toBe(false)
  })

  it('shows what is being chosen between instead of a command', async () => {
    const agent = fakeAgent()
    const session = start(agent)
    void agent.ask('session/request_permission', {
      sessionId: 'acp-1',
      toolCall: {
        toolCallId: 't1',
        title: 'Pick a branch',
        content: [{ type: 'content', content: { type: 'text', text: 'main or develop?' } }],
      },
      options: [
        { optionId: 'a', name: 'main', kind: 'allow_once' },
        { optionId: 'b', name: 'develop', kind: 'allow_once' },
      ],
    })
    expect(await nextEvent(session, (e) => e.type === 'approval.requested')).toMatchObject({
      title: 'Pick a branch',
      detail: 'main or develop?',
    })
    await session.close()
  })
})

async function nextEventFrom(events: SessionEvent[], pred: (e: SessionEvent) => boolean) {
  for (let i = 0; i < 400; i++) {
    const found = events.find(pred)
    if (found) return found
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('event never arrived')
}
