import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderInstance, SessionEvent, StoredEvent } from '@beddcode/contracts'
import {
  AgentTools,
  MAX_TOTAL_CHILDREN,
  isInsideFolder,
  modeLevel,
  type AgentToolsHost,
} from './agentTools.ts'

describe('modeLevel', () => {
  it('ranks modes across agents', () => {
    expect(modeLevel({ id: 'plan', label: 'Plan mode' })).toBe(0)
    expect(modeLevel({ id: 'read-only', label: 'Read only' })).toBe(0)
    expect(modeLevel({ id: 'default', label: 'Ask before edits' })).toBe(1)
    expect(modeLevel({ id: 'ask', label: 'Ask before edits' })).toBe(1)
    expect(modeLevel({ id: 'acceptEdits', label: 'Auto-accept edits' })).toBe(2)
    expect(modeLevel({ id: 'auto', label: 'Auto-accept edits' })).toBe(2)
    expect(modeLevel({ id: 'full', label: 'Full access', dangerous: true })).toBe(3)
    expect(modeLevel({ id: 'bypassPermissions', label: 'Full access' })).toBe(3)
  })
})

const provider = (id: string, modes: { id: string; label: string; dangerous?: boolean }[]) =>
  ({
    id,
    kind: 'codex',
    label: id,
    status: 'ready',
    capabilities: { permissionModes: modes, models: [{ id: 'm1', label: 'M1' }] },
  }) as unknown as ProviderInstance

const CODEX = provider('codex', [
  { id: 'read-only', label: 'Read only' },
  { id: 'ask', label: 'Ask before edits' },
  { id: 'auto', label: 'Auto-accept edits' },
  { id: 'full', label: 'Full access', dangerous: true },
])

/** A host with an in-memory log; created sessions get a session.created event. */
function fakeHost(parentProjectless = false) {
  const logs = new Map<string, StoredEvent[]>()
  let seq = 0
  const listeners = new Set<(e: StoredEvent) => void>()
  const append = (event: SessionEvent) => {
    const stored = { seq: ++seq, event }
    logs.set(event.sessionId, [...(logs.get(event.sessionId) ?? []), stored])
    listeners.forEach((l) => l(stored))
  }
  const created: { params: Record<string, unknown>; origin: unknown }[] = []
  const prompts: [string, string][] = []
  const interrupts: [string, { includeChildren?: boolean } | undefined][] = []
  const failPrompt = new Set<string>()
  let n = 0
  const host: AgentToolsHost = {
    async create(params, origin) {
      const sessionId = `child-${++n}`
      created.push({ params, origin })
      append({
        type: 'session.created',
        sessionId,
        at: 0,
        title: params.title ?? 'Child',
        cwd: params.cwd ?? '/p',
        projectless: params.projectless,
        instanceId: params.instanceId,
        permissionMode: params.permissionMode,
        parent: origin.parent,
        agentTools: params.agentTools,
      })
      return { sessionId }
    },
    async prompt(sessionId, text) {
      if (failPrompt.has(sessionId)) throw new Error('the agent is gone')
      prompts.push([sessionId, text])
      append({ type: 'turn.started', sessionId, at: Date.now() })
      return { state: 'started' }
    },
    async interrupt(sessionId, options) {
      interrupts.push([sessionId, options])
      append({ type: 'turn.completed', sessionId, at: 0, reason: 'cancelled' })
    },
    isBusy: () => false,
    currentMode: (id) => {
      const c = logs.get(id)?.find((e) => e.event.type === 'session.created')?.event
      return c?.type === 'session.created' ? c.permissionMode : undefined
    },
    providers: async () => [CODEX],
    readSession: (id) => logs.get(id) ?? [],
    childrenOf: (id) =>
      [...logs.entries()]
        .filter(([, events]) => {
          const c = events[0]?.event
          return c?.type === 'session.created' && c.parent?.sessionId === id
        })
        .map(([sid]) => sid),
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    projectPaths: async () => ['/projects/other'],
    report: (sessionId, status, summary) =>
      append({ type: 'session.result', sessionId, at: 0, status, summary }),
  }
  append({
    type: 'session.created',
    sessionId: 'parent',
    at: 0,
    title: 'Parent',
    cwd: '/p',
    projectPath: parentProjectless ? undefined : '/p',
    projectless: parentProjectless || undefined,
    instanceId: 'claude',
    permissionMode: 'acceptEdits',
    agentTools: true,
  })
  append({
    type: 'session.modes',
    sessionId: 'parent',
    at: 0,
    modes: [
      { id: 'default', label: 'Ask before edits' },
      { id: 'acceptEdits', label: 'Auto-accept edits' },
      { id: 'bypassPermissions', label: 'Full access', dangerous: true },
    ],
    currentModeId: 'acceptEdits',
  })
  return { host, append, created, prompts, interrupts, failPrompt }
}

const tools = (host: AgentToolsHost) =>
  new AgentTools(host, { file: '/bridge.mjs', url: () => 'http://127.0.0.1:1/agent-tools' })

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text
const call = async (t: AgentTools, session: string, name: string, args: object) => {
  const r = (await t.handle(session, 'tools/call', { name, arguments: args })) as {
    isError?: boolean
  }
  if (r.isError) throw new Error(text(r))
  return JSON.parse(text(r)) as Record<string, unknown>
}

afterEach(() => vi.useRealTimers())

describe('AgentTools', () => {
  it('gives each session its own key and lists the tools', async () => {
    const t = tools(fakeHost().host)
    const [server] = t.serversFor('parent')
    expect(server).toMatchObject({ name: 'beddcode', args: ['/bridge.mjs'] })
    expect(t.sessionFor(server!.env.BEDDCODE_TOOLS_TOKEN)).toBe('parent')
    expect(t.serversFor('parent')[0]!.env.BEDDCODE_TOOLS_TOKEN).toBe(
      server!.env.BEDDCODE_TOOLS_TOKEN,
    )
    expect(t.sessionFor('nope')).toBeUndefined()
    const listed = (await t.handle('parent', 'tools/list', {})) as { tools: { name: string }[] }
    expect(listed.tools.map((x) => x.name)).toContain('start_session')
  })

  it('keeps the child of a session without a project without a project too', async () => {
    const { host, created } = fakeHost(true)
    await call(tools(host), 'parent', 'start_session', { agent: 'codex', prompt: 'hi' })
    expect(created[0]!.params).toMatchObject({ projectless: true })
    expect(created[0]!.params.cwd).toBeUndefined()
  })

  it('starts a child no looser than its parent, nested under it, and sends the prompt', async () => {
    const { host, created, prompts } = fakeHost()
    const t = tools(host)
    const started = await call(t, 'parent', 'start_session', {
      agent: 'codex',
      prompt: 'Write tests',
      worktree: true,
    })
    expect(started).toMatchObject({ session_id: 'child-1', mode: 'auto' })
    expect(created[0]).toMatchObject({
      params: {
        instanceId: 'codex',
        cwd: '/p',
        permissionMode: 'auto',
        workspace: { mode: 'worktree' },
        agentTools: true,
      },
      origin: { parent: { sessionId: 'parent', depth: 1 } },
    })
    expect(prompts).toEqual([['child-1', 'Write tests']])

    await expect(
      call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'x', mode: 'full' }),
    ).rejects.toThrow(/allows more than/)
    await expect(
      call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'x', folder: '/etc' }),
    ).rejects.toThrow(/not this session's folder/)
    expect(
      await call(t, 'parent', 'start_session', {
        agent: 'codex',
        prompt: 'x',
        folder: '/projects/other/sub',
      }),
    ).toMatchObject({ folder: path.resolve('/projects/other/sub') })
  })

  it('only lets a session drive its own children, and limits depth', async () => {
    const { host } = fakeHost()
    const t = tools(host)
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'a' })
    // The child (depth 1) may start one more level; that grandchild may not.
    await call(t, 'child-1', 'start_session', { agent: 'codex', prompt: 'b' })
    await expect(
      call(t, 'child-2', 'start_session', { agent: 'codex', prompt: 'c' }),
    ).rejects.toThrow(/nest 2 deep/)
    await expect(call(t, 'child-1', 'get_status', { session_id: 'parent' })).rejects.toThrow(
      /not a session you started/,
    )
    expect(await call(t, 'parent', 'get_status', { session_id: 'child-1' })).toMatchObject({
      status: 'running',
    })
  })

  it('lets a child report how its task ended, and hands that to the parent', async () => {
    const { host, append } = fakeHost()
    const t = tools(host)
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'go' })
    await call(t, 'child-1', 'start_session', { agent: 'codex', prompt: 'deeper' })

    const names = async (id: string) =>
      ((await t.handle(id, 'tools/list', {})) as { tools: { name: string }[] }).tools.map(
        (x) => x.name,
      )
    expect(await names('parent')).not.toContain('report_result')
    expect(await names('child-1')).toEqual(
      expect.arrayContaining(['start_session', 'report_result']),
    )
    // The deepest level cannot start sessions, but can still report.
    expect(await names('child-2')).toEqual(['report_result'])

    await expect(
      call(t, 'parent', 'report_result', { status: 'done', summary: 'x' }),
    ).rejects.toThrow(/started/)
    await expect(
      call(t, 'child-1', 'report_result', { status: 'great', summary: 'x' }),
    ).rejects.toThrow(/one of done, blocked, failed/)
    await call(t, 'child-1', 'report_result', { status: 'blocked', summary: 'Needs the API key' })
    append({ type: 'turn.completed', sessionId: 'child-1', at: 0, reason: 'done' })
    expect(await call(t, 'parent', 'wait_for', { session_id: 'child-1' })).toMatchObject({
      done: true,
      result: { status: 'blocked', summary: 'Needs the API key' },
    })

    // A follow-up starts a new task, so the old outcome is dropped.
    await call(t, 'parent', 'send_message', { session_id: 'child-1', text: 'here is the key' })
    append({ type: 'turn.completed', sessionId: 'child-1', at: 0, reason: 'done' })
    expect(await call(t, 'parent', 'wait_for', { session_id: 'child-1' })).not.toHaveProperty(
      'result',
    )
  })

  it('keeps a child’s result in its log, so a new AgentTools still has it', async () => {
    const { host, append } = fakeHost()
    await call(tools(host), 'parent', 'start_session', { agent: 'codex', prompt: 'go' })
    await call(tools(host), 'child-1', 'report_result', { status: 'done', summary: 'Shipped' })
    append({ type: 'turn.completed', sessionId: 'child-1', at: 0, reason: 'done' })
    // A restarted host builds a fresh AgentTools over the same log.
    const restarted = tools(host)
    expect(await call(restarted, 'parent', 'wait_for', { session_id: 'child-1' })).toMatchObject({
      result: { status: 'done', summary: 'Shipped' },
      data_notice: expect.stringContaining('data'),
    })
    expect(await call(restarted, 'parent', 'list_children', {})).toEqual([
      expect.objectContaining({ session_id: 'child-1', reported: 'done' }),
    ])
  })

  it('returns the same session for a repeated request_id instead of starting a second', async () => {
    const { host, created, prompts } = fakeHost()
    const t = tools(host)
    const first = await call(t, 'parent', 'start_session', {
      agent: 'codex',
      prompt: 'go',
      request_id: 'job-1',
    })
    const again = await call(t, 'parent', 'start_session', {
      agent: 'codex',
      prompt: 'go',
      request_id: 'job-1',
    })
    expect(again).toMatchObject({ session_id: first.session_id, already_started: true })
    const other = await call(t, 'parent', 'start_session', {
      agent: 'codex',
      prompt: 'go',
      request_id: 'job-2',
    })
    expect(other.session_id).not.toBe(first.session_id)
    expect(created).toHaveLength(2)
    expect(prompts).toHaveLength(2)
    expect(created[0]!.origin).toMatchObject({ parent: { requestId: 'job-1' } })
  })

  it('checks limits one start at a time, so parallel calls cannot overshoot', async () => {
    const { host, created } = fakeHost()
    const t = tools(host)
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        call(t, 'parent', 'start_session', { agent: 'codex', prompt: String(i) }),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3)
    expect(created).toHaveLength(5)
  })

  it('does not start a second session for two parallel calls with one request_id', async () => {
    const { host, created } = fakeHost()
    const t = tools(host)
    const [a, b] = await Promise.all([
      call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'go', request_id: 'same' }),
      call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'go', request_id: 'same' }),
    ])
    expect(a.session_id).toBe(b.session_id)
    expect(created).toHaveLength(1)
  })

  it('stops a child that goes silent, with what it started, and says why', async () => {
    vi.useFakeTimers()
    const { host, interrupts } = fakeHost()
    const t = tools(host)
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'go', idle_minutes: 2 })
    await vi.advanceTimersByTimeAsync(119_000)
    expect(interrupts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(interrupts).toEqual([['child-1', { includeChildren: true }]])
    expect(await call(t, 'parent', 'get_status', { session_id: 'child-1' })).toMatchObject({
      result: { status: 'failed', summary: expect.stringContaining('no activity for 2 minutes') },
    })
  })

  it('never stops a child that keeps working, or one waiting for the user', async () => {
    vi.useFakeTimers()
    const { host, append, interrupts } = fakeHost()
    const t = tools(host)
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'go', idle_minutes: 2 })
    // Activity every minute for ten minutes: far past the limit, never silent for it.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(60_000)
      append({ type: 'tool.started', sessionId: 'child-1', at: Date.now() } as never)
    }
    expect(interrupts).toHaveLength(0)

    // Waiting on an approval is not being stuck.
    append({
      type: 'approval.requested',
      sessionId: 'child-1',
      at: Date.now(),
      requestId: 'r',
      title: 'Run it?',
      options: [],
    })
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(interrupts).toHaveLength(0)
  })

  it('leaves a finished child alone, and lets the caller turn the limit off', async () => {
    vi.useFakeTimers()
    const { host, append, interrupts } = fakeHost()
    const t = tools(host)
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'a', idle_minutes: 1 })
    append({ type: 'turn.completed', sessionId: 'child-1', at: Date.now(), reason: 'done' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'b', idle_minutes: 0 })
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(interrupts).toHaveLength(0)
  })

  it('applies the default limit, capped, and restarts the clock on a follow-up message', async () => {
    vi.useFakeTimers()
    const { host, append, interrupts } = fakeHost()
    const t = tools(host)
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'a' })
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    append({ type: 'turn.completed', sessionId: 'child-1', at: Date.now(), reason: 'done' })
    await call(t, 'parent', 'send_message', { session_id: 'child-1', text: 'more' })
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(interrupts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(interrupts).toEqual([['child-1', { includeChildren: true }]])

    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'b', idle_minutes: 99_999 })
    await vi.advanceTimersByTimeAsync(239 * 60_000)
    expect(interrupts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(interrupts).toHaveLength(2)
  })

  it('reports a session whose first message could not be sent, and says how to recover', async () => {
    const { host, failPrompt, created } = fakeHost()
    failPrompt.add('child-1')
    const t = tools(host)
    await expect(
      call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'go' }),
    ).rejects.toThrow(/child-1.*could not send its first message.*the agent is gone/)
    expect(created).toHaveLength(1)
    failPrompt.clear()
    expect(await call(t, 'parent', 'get_status', { session_id: 'child-1' })).toMatchObject({
      result: { status: 'failed' },
    })
  })

  it('stops a child together with what it started, and forgets a deleted session', async () => {
    const { host, interrupts } = fakeHost()
    const t = tools(host)
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'go' })
    await call(t, 'parent', 'stop', { session_id: 'child-1' })
    expect(interrupts).toEqual([['child-1', { includeChildren: true }]])

    const [server] = t.serversFor('parent')
    const token = server!.env.BEDDCODE_TOOLS_TOKEN
    t.forget('parent')
    expect(t.sessionFor(token)).toBeUndefined()
    // A fresh key is made if the session is resumed later.
    expect(t.serversFor('parent')[0]!.env.BEDDCODE_TOOLS_TOKEN).not.toBe(token)
  })

  it('caps how many children a session starts', async () => {
    const { host, append } = fakeHost()
    const t = tools(host)
    for (let i = 0; i < MAX_TOTAL_CHILDREN; i++) {
      await call(t, 'parent', 'start_session', { agent: 'codex', prompt: String(i) })
      // Finish each so the running cap does not apply first.
      append({ type: 'turn.completed', sessionId: `child-${i + 1}`, at: 0, reason: 'done' })
    }
    await expect(
      call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'x' }),
    ).rejects.toThrow(/at most/)
  })

  it('waits for a child to finish, or to need the user, and returns its reply', async () => {
    const { host, append } = fakeHost()
    const t = tools(host)
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'go' })
    const waiting = call(t, 'parent', 'wait_for', { session_id: 'child-1', timeout_seconds: 5 })
    append({
      type: 'approval.requested',
      sessionId: 'child-1',
      at: 0,
      requestId: 'r1',
      title: 'Run npm test',
      options: [],
    })
    expect(await waiting).toMatchObject({
      status: 'needs-you',
      done: false,
      waiting_on: expect.stringContaining('Run npm test'),
    })

    const again = call(t, 'parent', 'wait_for', { session_id: 'child-1', timeout_seconds: 5 })
    append({
      type: 'approval.resolved',
      sessionId: 'child-1',
      at: 0,
      requestId: 'r1',
      optionId: 'allow',
    })
    append({
      type: 'message.delta',
      sessionId: 'child-1',
      at: 0,
      role: 'assistant',
      text: 'All green.',
    })
    append({ type: 'turn.completed', sessionId: 'child-1', at: 0, reason: 'done' })
    expect(await again).toMatchObject({ status: 'idle', done: true, reply: 'All green.' })
    expect(await call(t, 'parent', 'read_transcript', { session_id: 'child-1' })).toMatchObject({
      transcript: expect.stringContaining('Agent: All green.'),
    })
    expect(await call(t, 'parent', 'list_children', {})).toEqual([
      expect.objectContaining({ session_id: 'child-1', status: 'idle' }),
    ])
  })
})

describe('isInsideFolder', () => {
  it('matches the folder and what is under it, on POSIX and Windows paths', () => {
    expect(isInsideFolder('/p', '/p', path.posix)).toBe(true)
    expect(isInsideFolder('/p', '/p/a/b', path.posix)).toBe(true)
    expect(isInsideFolder('/p', '/pa', path.posix)).toBe(false)
    expect(isInsideFolder('/p', '/p/..foo', path.posix)).toBe(true)
    expect(isInsideFolder('/p', '/p/../etc', path.posix)).toBe(false)
    expect(isInsideFolder('/', '/etc', path.posix)).toBe(true)
    expect(isInsideFolder('D:\\Projects', 'd:\\projects\\other', path.win32)).toBe(true)
    expect(isInsideFolder('D:\\projects', 'D:/projects/x', path.win32)).toBe(true)
    expect(isInsideFolder('C:\\', 'C:\\Users', path.win32)).toBe(true)
    expect(isInsideFolder('D:\\projects', 'E:\\projects', path.win32)).toBe(false)
    expect(isInsideFolder('D:\\projects', 'D:\\projects2', path.win32)).toBe(false)
  })
})
