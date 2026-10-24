import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { createLogger, type Transport } from '@beddcode/shared'
import { createCodexAdapter } from './adapter.ts'
import { CodexSession } from './session.ts'

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }

/** An in-memory `codex app-server`: records what the client sent and lets the test push messages. */
function fakeServer() {
  let lineHandler: (line: string) => void = () => {}
  let closeHandler: () => void = () => {}
  const received: Msg[] = []
  const waiters: (() => void)[] = []
  let nextServerId = 100

  const auto: Record<string, (p: Record<string, unknown>) => unknown> = {
    initialize: () => ({ userAgent: 'fake' }),
    'thread/start': () => ({ thread: { id: 'th1' } }),
    'thread/resume': (p) => ({ thread: { id: String(p.threadId) } }),
    'turn/start': () => ({ turn: { id: 'tu1' } }),
    'turn/interrupt': () => ({}),
    'turn/steer': () => ({ turnId: 'tu1' }),
    'skills/list': () => ({ data: [] }),
  }

  const transport: Transport = {
    send(line) {
      const msg = JSON.parse(line) as Msg
      received.push(msg)
      if (msg.id !== undefined && msg.method && auto[msg.method]) {
        const result = auto[msg.method]!(msg.params ?? {})
        queueMicrotask(() =>
          result instanceof Error
            ? lineHandler(
                JSON.stringify({ id: msg.id, error: { code: -1, message: result.message } }),
              )
            : lineHandler(JSON.stringify({ id: msg.id, result })),
        )
      }
      waiters.splice(0).forEach((w) => w())
    },
    onLine: (h) => (lineHandler = h),
    onClose: (h) => (closeHandler = h),
    close: () => closeHandler(),
  }

  return {
    transport,
    received,
    auto,
    notify: (method: string, params: unknown) => lineHandler(JSON.stringify({ method, params })),
    /** Sends a server request and resolves with the client's reply. */
    ask(method: string, params: unknown): Promise<Msg> {
      const id = nextServerId++
      lineHandler(JSON.stringify({ id, method, params }))
      return this.waitFor((m) => m.id === id && m.method === undefined)
    },
    async waitFor(pred: (m: Msg) => boolean): Promise<Msg> {
      for (;;) {
        const found = received.find(pred)
        if (found) return found
        await new Promise<void>((r) => waiters.push(r))
      }
    },
    sent: (method: string) => received.filter((m) => m.method === method),
    die: () => closeHandler(),
  }
}

const log = createLogger('test', 'error')
const start = (
  server: ReturnType<typeof fakeServer>,
  input: Partial<ConstructorParameters<typeof CodexSession>[0]> = {},
) =>
  new CodexSession(
    { sessionId: 's1', cwd: '/work', ...input },
    { transport: server.transport, log, promptsDir: '/nonexistent-prompts' },
  )

async function nextEvent(session: CodexSession, pred: (e: SessionEvent) => boolean) {
  for await (const e of session.events) if (pred(e)) return e
  throw new Error('stream ended')
}

const completeTurn = (s: ReturnType<typeof fakeServer>, status = 'completed') =>
  s.notify('turn/completed', { threadId: 'th1', turn: { id: 'tu1', status } })

describe('CodexSession', () => {
  it('isolates metadata generation in an ephemeral read-only thread', async () => {
    const server = fakeServer()
    const session = start(server, { textOnly: true, effort: 'low' })
    await nextEvent(session, (e) => e.type === 'session.provider-session')
    expect(server.sent('thread/start')[0]?.params).toMatchObject({
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      config: { 'features.shell_tool': false, mcp_servers: {} },
    })
    expect(server.sent('skills/list')).toHaveLength(0)
    const turn = session.prompt({ text: 'Draft JSON' })
    await server.waitFor((m) => m.method === 'turn/start')
    expect(server.sent('turn/start')[0]?.params).toMatchObject({ effort: 'low' })
    completeTurn(server)
    await turn
    await session.close()
  })
  it("starts a thread with the mode's approval policy and sandbox and records the thread id", async () => {
    const server = fakeServer()
    const session = start(server, { permissionMode: 'full', model: 'gpt-x' })
    const event = await nextEvent(session, (e) => e.type === 'session.provider-session')
    expect(event).toMatchObject({ providerSessionId: 'th1' })
    expect(server.sent('thread/start')[0]?.params).toMatchObject({
      cwd: '/work',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      model: 'gpt-x',
    })
    expect(server.sent('initialized')).toHaveLength(1)
    await session.close()
  })

  it('defaults to asking before edits', async () => {
    const server = fakeServer()
    const session = start(server)
    await nextEvent(session, (e) => e.type === 'session.provider-session')
    expect(server.sent('thread/start')[0]?.params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    })
    await session.close()
  })

  it('resumes an existing thread instead of starting a new one', async () => {
    const server = fakeServer()
    const session = start(server, { resumeId: 'old-thread' })
    await nextEvent(session, (e) => e.type === 'session.provider-session')
    expect(server.sent('thread/start')).toHaveLength(0)
    expect(server.sent('thread/resume')[0]?.params).toMatchObject({
      threadId: 'old-thread',
      cwd: '/work',
    })
    await session.close()
  })

  it.each([
    ['allow', 'accept'],
    ['allow-session', 'acceptForSession'],
    ['deny', 'decline'],
  ])('relays a command approval: %s -> %s', async (optionId, decision) => {
    const server = fakeServer()
    const session = start(server)
    const turn = session.prompt({ text: 'go' })
    await server.waitFor((m) => m.method === 'turn/start')

    const reply = server.ask('item/commandExecution/requestApproval', {
      threadId: 'th1',
      turnId: 'tu1',
      itemId: 'c1',
      command: "bash -lc 'pnpm test'",
    })
    const request = await nextEvent(session, (e) => e.type === 'approval.requested')
    if (request.type !== 'approval.requested') throw new Error('unreachable')
    expect(request).toMatchObject({ title: 'Running pnpm test?', detail: "bash -lc 'pnpm test'" })
    expect(request.options.map((o) => o.id)).toEqual(['allow', 'deny', 'allow-session'])

    await session.respondToApproval(request.requestId, optionId)
    expect((await reply).result).toEqual({ decision })

    completeTurn(server)
    await turn
    await session.close()
  })

  it('describes a file-change approval from the item it refers to and emits the diff after', async () => {
    const server = fakeServer()
    const session = start(server)
    const turn = session.prompt({ text: 'go' })
    await server.waitFor((m) => m.method === 'turn/start')

    const changes = [
      {
        path: '/work/src/a.ts',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1 @@\n-a\n+b\n',
      },
    ]
    server.notify('item/started', {
      threadId: 'th1',
      turnId: 'tu1',
      item: { type: 'fileChange', id: 'f1', changes, status: 'inProgress' },
    })
    const reply = server.ask('item/fileChange/requestApproval', {
      threadId: 'th1',
      turnId: 'tu1',
      itemId: 'f1',
    })
    const request = await nextEvent(session, (e) => e.type === 'approval.requested')
    expect(request).toMatchObject({ title: 'Editing src/a.ts?', detail: '/work/src/a.ts' })
    if (request.type !== 'approval.requested') throw new Error('unreachable')

    await session.respondToApproval(request.requestId, 'allow')
    expect((await reply).result).toEqual({ decision: 'accept' })
    server.notify('item/completed', {
      threadId: 'th1',
      turnId: 'tu1',
      item: { type: 'fileChange', id: 'f1', changes, status: 'completed' },
    })
    const diff = await nextEvent(session, (e) => e.type === 'diff')
    expect(diff).toMatchObject({ path: 'src/a.ts', added: 1, removed: 1 })
    completeTurn(server)
    await turn
    await session.close()
  })

  it("maps a permissions request to Codex's grant shape", async () => {
    const server = fakeServer()
    const session = start(server)
    const reply = server.ask('item/permissions/requestApproval', {
      threadId: 'th1',
      reason: 'Need network',
      permissions: { network: { enabled: true } },
    })
    const request = await nextEvent(session, (e) => e.type === 'approval.requested')
    if (request.type !== 'approval.requested') throw new Error('unreachable')
    await session.respondToApproval(request.requestId, 'allow-session')
    expect((await reply).result).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'session',
    })
    await session.close()
  })

  it('declines MCP forms instead of leaving Codex waiting', async () => {
    const server = fakeServer()
    const session = start(server)
    expect(
      (await server.ask('mcpServer/elicitation/request', { threadId: 'th1' })).result,
    ).toMatchObject({ action: 'decline' })
    await session.close()
  })

  it('applies a mode change once, to the next turn', async () => {
    const server = fakeServer()
    const session = start(server)
    await session.setPermissionMode('read-only')

    const first = session.prompt({ text: 'one' })
    await server.waitFor((m) => m.method === 'turn/start')
    completeTurn(server)
    await first
    const second = session.prompt({ text: 'two' })
    await new Promise((r) => setTimeout(r, 5))
    completeTurn(server)
    await second

    const [t1, t2] = server.sent('turn/start')
    expect(t1?.params).toMatchObject({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly' },
    })
    expect(t2?.params).not.toHaveProperty('approvalPolicy')
    await session.close()
  })

  it('interrupt cancels open approvals and asks Codex to stop the turn', async () => {
    const server = fakeServer()
    const session = start(server)
    const turn = session.prompt({ text: 'go' })
    await server.waitFor((m) => m.method === 'turn/start')
    const reply = server.ask('item/commandExecution/requestApproval', {
      threadId: 'th1',
      itemId: 'c1',
      command: 'x',
    })
    await nextEvent(session, (e) => e.type === 'approval.requested')

    // The turn id is only known once turn/start has answered.
    await new Promise((r) => setTimeout(r, 5))
    await session.interrupt()
    expect((await reply).result).toEqual({ decision: 'cancel' })
    expect(server.sent('turn/interrupt')[0]?.params).toMatchObject({
      threadId: 'th1',
      turnId: 'tu1',
    })

    completeTurn(server, 'interrupted')
    await turn
    const events: SessionEvent[] = []
    await session.close()
    for await (const e of session.events) events.push(e)
    expect(events.some((e) => e.type === 'turn.completed' && e.reason === 'cancelled')).toBe(true)
  })

  it('reports a failed turn/start as a finished turn without throwing', async () => {
    const server = fakeServer()
    server.auto['turn/start'] = () => new Error('rate limited')
    const session = start(server)
    await session.prompt({ text: 'go' })
    const events: SessionEvent[] = []
    await session.close()
    for await (const e of session.events) events.push(e)
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['turn.started', 'error', 'turn.completed']),
    )
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'rate limited' })
  })

  it('ignores notifications for other threads', async () => {
    const server = fakeServer()
    const session = start(server)
    await nextEvent(session, (e) => e.type === 'session.provider-session')
    server.notify('item/completed', {
      threadId: 'other',
      item: { type: 'agentMessage', id: 'x', text: 'nope' },
    })
    server.notify('item/completed', {
      threadId: 'th1',
      item: { type: 'agentMessage', id: 'y', text: 'yes' },
    })
    const e = await nextEvent(session, (ev) => ev.type === 'message.delta')
    expect(e).toMatchObject({ text: 'yes' })
    await session.close()
  })

  it('ends the turn with an error when the process dies mid-turn', async () => {
    const server = fakeServer()
    const session = start(server)
    const turn = session.prompt({ text: 'go' })
    await server.waitFor((m) => m.method === 'turn/start')
    await new Promise((r) => setTimeout(r, 5))
    server.die()
    await turn
    const events: SessionEvent[] = []
    for await (const e of session.events) events.push(e)
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: expect.stringContaining('ended'),
    })
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'error' })
  })
})

describe('createCodexAdapter', () => {
  it("reports not-installed for a missing binary and lists Codex's own modes", async () => {
    const adapter = createCodexAdapter({ executablePath: '/definitely/not/here/codex' })
    const [instance] = await adapter.detect()
    expect(instance).toMatchObject({ id: 'codex', kind: 'codex', status: 'not-installed' })
    expect(instance?.capabilities.permissionModes.map((m) => m.id)).toEqual([
      'ask',
      'auto',
      'read-only',
      'full',
    ])
    await expect(adapter.startSession('codex', { sessionId: 's', cwd: '/x' })).rejects.toThrow(
      'not installed',
    )
  })
})

describe('steering, questions, plans and skills', () => {
  const finish = (server: ReturnType<typeof fakeServer>) => completeTurn(server)

  it('steers the running turn by its id, and starts a turn when none is running', async () => {
    const server = fakeServer()
    const session = start(server)
    const turn = session.prompt({ text: 'first' })
    await server.waitFor((m) => m.method === 'turn/start')
    await new Promise((r) => setTimeout(r, 5))

    await session.steer({ text: 'also this' })
    expect(server.sent('turn/steer')[0]?.params).toMatchObject({
      threadId: 'th1',
      expectedTurnId: 'tu1',
      input: [{ type: 'text', text: 'also this' }],
    })
    finish(server)
    await turn

    const idle = session.steer({ text: 'nothing running' })
    await new Promise((r) => setTimeout(r, 5))
    expect(server.sent('turn/start')).toHaveLength(2)
    expect(server.sent('turn/steer')).toHaveLength(1)
    finish(server)
    await idle
    await session.close()
  })

  it('lets the user answer a question and returns the answers by question id', async () => {
    const server = fakeServer()
    const session = start(server)
    const asked = nextEvent(session, (e) => e.type === 'question.requested')
    const reply = server.ask('item/tool/requestUserInput', {
      threadId: 'th1',
      turnId: 'tu1',
      itemId: 'i1',
      isBlocking: true,
      questions: [
        {
          id: 'lang',
          header: 'Language',
          question: 'Which language?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'TypeScript', description: 'typed' },
            { label: 'Python', description: '' },
          ],
        },
        {
          id: 'token',
          header: 'Token',
          question: 'API token?',
          isOther: false,
          isSecret: true,
          options: null,
        },
      ],
    })
    const event = await asked
    if (event.type !== 'question.requested') throw new Error('no question')
    expect(event.questions).toMatchObject([
      {
        id: 'lang',
        header: 'Language',
        allowOther: true,
        options: [{ label: 'TypeScript' }, { label: 'Python' }],
      },
      { id: 'token', secret: true, allowOther: true },
    ])

    await session.answerQuestion(event.requestId, { lang: ['TypeScript'], token: ['abc'] })
    expect((await reply).result).toEqual({
      answers: { lang: { answers: ['TypeScript'] }, token: { answers: ['abc'] } },
    })
    await expect(session.answerQuestion(event.requestId)).rejects.toThrow('No pending question')
    await session.close()
  })

  it('answers open questions with nothing when the user interrupts', async () => {
    const server = fakeServer()
    const session = start(server)
    const asked = nextEvent(session, (e) => e.type === 'question.requested')
    const reply = server.ask('item/tool/requestUserInput', {
      threadId: 'th1',
      questions: [
        { id: 'a', header: 'A', question: 'Q?', isOther: true, isSecret: false, options: null },
      ],
    })
    await asked
    await session.interrupt()
    expect((await reply).result).toEqual({ answers: {} })
    await session.close()
  })

  it("shows Codex's plan updates", async () => {
    const server = fakeServer()
    const session = start(server)
    const planned = nextEvent(session, (e) => e.type === 'plan.updated')
    // Notifications are for the thread, which exists once the session has started.
    await server.waitFor((m) => m.method === 'thread/start')
    await new Promise((r) => setTimeout(r, 10))
    server.notify('turn/plan/updated', {
      threadId: 'th1',
      turnId: 'tu1',
      explanation: 'Because',
      plan: [
        { step: 'Read', status: 'completed' },
        { step: 'Edit', status: 'inProgress' },
        { step: 'Test', status: 'pending' },
      ],
    })
    expect(await planned).toMatchObject({
      explanation: 'Because',
      steps: [
        { text: 'Read', status: 'completed' },
        { text: 'Edit', status: 'in-progress' },
        { text: 'Test', status: 'pending' },
      ],
    })
    await session.close()
  })

  it('lists skills as commands and sends a leading /skill as a skill input', async () => {
    const server = fakeServer()
    server.auto['skills/list'] = () => ({
      data: [
        {
          cwd: '/work',
          skills: [
            { name: 'pdf', description: 'Work with PDFs', path: '/skills/pdf', enabled: true },
            { name: 'off', description: 'Disabled', path: '/skills/off', enabled: false },
          ],
        },
      ],
    })
    const session = start(server)
    const listed = await nextEvent(session, (e) => e.type === 'session.commands')
    expect(listed.type === 'session.commands' && listed.commands.map((c) => c.name)).toEqual([
      'compact',
      'review',
      'pdf',
    ])
    expect(listed).toMatchObject({
      commands: [{}, {}, { name: 'pdf', description: 'Work with PDFs', kind: 'skill' }],
    })

    const turn = session.prompt({ text: '/pdf merge these files' })
    await server.waitFor((m) => m.method === 'turn/start')
    expect(server.sent('turn/start')[0]?.params?.input).toEqual([
      { type: 'skill', name: 'pdf', path: '/skills/pdf' },
      { type: 'text', text: 'merge these files', text_elements: [] },
    ])
    finish(server)
    await turn

    const plain = session.prompt({ text: '/unknown thing' })
    await new Promise((r) => setTimeout(r, 5))
    expect(server.sent('turn/start')[1]?.params?.input).toEqual([
      { type: 'text', text: '/unknown thing', text_elements: [] },
    ])
    finish(server)
    await plain
    await session.close()
  })
})

describe('switching models', () => {
  it('sends the chosen model and effort with every turn from then on', async () => {
    const server = fakeServer()
    const session = start(server, { model: 'gpt-a', effort: 'low' })
    const first = session.prompt({ text: 'one' })
    await server.waitFor((m) => m.method === 'turn/start')
    expect(server.sent('turn/start')[0]?.params).toMatchObject({ model: 'gpt-a', effort: 'low' })
    completeTurn(server)
    await first

    await session.setModel('gpt-b', 'high')
    const second = session.prompt({ text: 'two' })
    await new Promise((r) => setTimeout(r, 5))
    expect(server.sent('turn/start')[1]?.params).toMatchObject({ model: 'gpt-b', effort: 'high' })
    completeTurn(server)
    await second

    await session.setModel(undefined, undefined)
    const third = session.prompt({ text: 'three' })
    await new Promise((r) => setTimeout(r, 5))
    expect(server.sent('turn/start')[2]?.params).not.toHaveProperty('model')
    completeTurn(server)
    await third
    await session.close()
  })
})

describe('Codex commands', () => {
  it('sends /compact and /review through their own requests', async () => {
    const server = fakeServer()
    server.auto['thread/compact/start'] = () => ({})
    server.auto['review/start'] = () => ({ turn: { id: 'rv1' }, reviewThreadId: 'th1' })
    const session = start(server)
    await nextEvent(session, (e) => e.type === 'session.commands')

    const compact = session.prompt({ text: '/compact' })
    await server.waitFor((m) => m.method === 'thread/compact/start')
    expect(server.sent('thread/compact/start')[0]?.params).toEqual({ threadId: 'th1' })
    completeTurn(server)
    await compact

    const review = session.prompt({ text: '/review focus on error handling' })
    await server.waitFor((m) => m.method === 'review/start')
    expect(server.sent('review/start')[0]?.params).toEqual({
      threadId: 'th1',
      target: { type: 'custom', instructions: 'focus on error handling' },
      delivery: 'inline',
    })
    completeTurn(server)
    await review

    const plain = session.prompt({ text: '/review' })
    await new Promise((r) => setTimeout(r, 5))
    expect(server.sent('review/start')[1]?.params?.target).toEqual({ type: 'uncommittedChanges' })
    completeTurn(server)
    await plain
    expect(server.sent('turn/start')).toHaveLength(0)
    await session.close()
  })

  it('expands a custom prompt with its arguments', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-prompts-'))
    writeFileSync(
      path.join(dir, 'fix.md'),
      '---\ndescription: Fix an issue\nargument-hint: <issue> [PRIORITY=x]\n---\nFix issue $1 with priority $PRIORITY. All: $ARGUMENTS',
    )
    const server = fakeServer()
    const session = new CodexSession(
      { sessionId: 's1', cwd: '/work' },
      { transport: server.transport, log, promptsDir: dir },
    )
    const listed = await nextEvent(session, (e) => e.type === 'session.commands')
    expect(listed).toMatchObject({
      commands: [
        {},
        {},
        { name: 'prompts:fix', description: 'Fix an issue', hint: '<issue> [PRIORITY=x]' },
      ],
    })
    const turn = session.prompt({ text: '/prompts:fix 42 PRIORITY=high' })
    await server.waitFor((m) => m.method === 'turn/start')
    expect(server.sent('turn/start')[0]?.params?.input).toEqual([
      { type: 'text', text: 'Fix issue 42 with priority high. All: 42', text_elements: [] },
    ])
    completeTurn(server)
    await turn
    await session.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
