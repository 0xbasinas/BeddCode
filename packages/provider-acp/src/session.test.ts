import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { createLogger, type Transport } from '@beddcode/shared'
import { createAcpAdapter } from './adapter.ts'
import { AcpAgentStore } from './config.ts'
import { AcpSession } from './session.ts'

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
                : { jsonrpc: '2.0', id: msg.id, result },
            ),
          ),
        )
      }
      waiters.splice(0).forEach((w) => w())
    },
    onLine: (h) => (lineHandler = h),
    onClose: (h) => (closeHandler = h),
    close: () => closeHandler(),
  }

  const agent = {
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
    expect(request).toMatchObject({ title: 'Edit notes.txt', detail: '/w/notes.txt' })
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
