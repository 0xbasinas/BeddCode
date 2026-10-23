import { describe, expect, it } from 'vitest'
import type { ProviderInstance, SessionEvent, StoredEvent } from '@beddcode/contracts'
import { AgentTools, MAX_TOTAL_CHILDREN, modeLevel, type AgentToolsHost } from './agentTools.ts'

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
function fakeHost() {
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
        instanceId: params.instanceId,
        permissionMode: params.permissionMode,
        parent: origin.parent,
        agentTools: params.agentTools,
      })
      return { sessionId }
    },
    async prompt(sessionId, text) {
      prompts.push([sessionId, text])
      append({ type: 'turn.started', sessionId, at: 0 })
      return { state: 'started' }
    },
    async interrupt() {},
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
  }
  append({
    type: 'session.created',
    sessionId: 'parent',
    at: 0,
    title: 'Parent',
    cwd: '/p',
    projectPath: '/p',
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
  return { host, append, created, prompts }
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
    ).toMatchObject({ folder: '/projects/other/sub' })
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
