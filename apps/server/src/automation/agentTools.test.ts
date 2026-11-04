import path from 'node:path'
import type { DesignTools } from '../design/designTools.ts'
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
    recentSessionIds: (limit) => [...logs.keys()].slice(0, limit),
    promptPeer: async (id, text) => {
      if (failPrompt.has(id)) throw new Error('the agent is gone')
      prompts.push([id, text])
      return { state: 'queued' }
    },
    recordPeerMessage: (message) => {
      for (const sessionId of [message.senderId, message.recipientId])
        append({ type: 'agent.message', sessionId, ...message })
    },
    recordPlan: append,
    recordGroup: append,
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
    diff: async () => 'diff --git a/a.ts b/a.ts\n+changed line',
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
  it('enforces project-specific depth, worker and message limits', async () => {
    const { host, append } = fakeHost()
    const limits = {
      maxDepth: 0,
      maxWorkers: 1,
      maxTotalWorkers: 10,
      maxMessagesPerMinute: 1,
      maxMessages: 50,
      approval: 'off' as const,
    }
    host.limits = (project) =>
      project === '/p' ? limits : { ...limits, maxDepth: 2, maxMessages: 10 }
    const t = tools(host)
    await expect(
      call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'x' }),
    ).rejects.toThrow('nest 0')
    limits.maxDepth = 2
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'x' })
    await expect(
      call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'x' }),
    ).rejects.toThrow('still working')
    append({
      type: 'session.created',
      sessionId: 'peer',
      at: 0,
      title: 'Peer',
      cwd: '/p',
      projectPath: '/p',
      instanceId: 'codex',
      agentTools: true,
    })
    await call(t, 'parent', 'send_peer_message', { session_id: 'peer', text: 'one' })
    await expect(
      call(t, 'parent', 'send_peer_message', { session_id: 'peer', text: 'two' }),
    ).rejects.toThrow('Project message limit')
  })

  it('persists named peer groups for broadcasts and supports removal', async () => {
    const { host, append, prompts } = fakeHost()
    append({
      type: 'session.created',
      sessionId: 'peer',
      at: 0,
      title: 'Peer',
      cwd: '/p',
      projectPath: '/p',
      instanceId: 'codex',
      agentTools: true,
    })
    await call(tools(host), 'parent', 'set_peer_group', {
      name: 'reviewers',
      session_ids: ['peer', 'peer'],
    })
    const restarted = tools(host)
    const groups = await restarted.call('parent', 'list_peer_groups', {})
    expect(groups).toEqual([{ name: 'reviewers', session_ids: ['peer'] }])
    expect(
      await call(restarted, 'parent', 'broadcast_peer_message', {
        group: 'reviewers',
        text: 'Please review',
      }),
    ).toMatchObject({ outcomes: [{ session_id: 'peer', ok: true }] })
    expect(prompts).toHaveLength(1)
    await call(restarted, 'parent', 'set_peer_group', { name: 'reviewers', session_ids: [] })
    expect(await restarted.call('parent', 'list_peer_groups', {})).toEqual([])
  })
  it('records plans and reconnects workers and results after the tools restart', async () => {
    const { host, created, append } = fakeHost()
    const initial = await call(tools(host), 'parent', 'create_orchestration_plan', {
      goal: 'Ship the feature',
      tasks: [{ agent: 'codex', prompt: 'Implement it', worktree: true }],
    })
    expect(initial).toMatchObject({
      goal: 'Ship the feature',
      tasks: [{ session_id: 'child-1', agent: 'codex' }],
    })
    expect(created[0]?.params.workspace).toEqual({ mode: 'worktree' })
    expect(await tools(host).call('parent', 'list_orchestration_plans', {})).toEqual([
      { plan_id: initial.plan_id, goal: 'Ship the feature' },
    ])
    host.report('child-1', 'done', 'Implemented')
    append({ type: 'turn.completed', sessionId: 'child-1', at: 1, reason: 'done' })
    append({ type: 'turn.started', sessionId: 'child-1', at: 2 })
    append({ type: 'turn.completed', sessionId: 'child-1', at: 3, reason: 'done' })
    const recovered = await call(tools(host), 'parent', 'get_orchestration_plan', {
      plan_id: initial.plan_id,
      start_pending: true,
    })
    expect(recovered).toMatchObject({
      tasks: [{ session_id: 'child-1', status: 'done', result: { summary: 'Implemented' } }],
    })
    expect(created).toHaveLength(1)
  })

  it('keeps a failed assignment pending so it can be retried', async () => {
    const { host, created } = fakeHost()
    const initial = await call(tools(host), 'parent', 'create_orchestration_plan', {
      goal: 'Investigate',
      tasks: [{ agent: 'missing', prompt: 'Look' }],
    })
    expect(initial).toMatchObject({
      tasks: [{ status: 'pending', error: expect.stringContaining('No agent') }],
    })
    const recovered = await call(tools(host), 'parent', 'get_orchestration_plan', {
      plan_id: initial.plan_id,
    })
    expect(recovered).toMatchObject({ tasks: [{ status: 'pending' }] })
    expect(created).toHaveLength(0)
  })
  it('broadcasts once per recipient and reports individual failures', async () => {
    const { host, append, prompts } = fakeHost()
    for (const id of ['one', 'two'])
      append({
        type: 'session.created',
        sessionId: id,
        at: 0,
        title: id,
        cwd: '/p',
        projectPath: '/p',
        instanceId: 'codex',
        agentTools: true,
      })
    const result = await call(tools(host), 'parent', 'broadcast_peer_message', {
      session_ids: ['one', 'one', 'missing', 'two'],
      text: 'hello',
    })
    expect(result.outcomes).toMatchObject([
      { session_id: 'one', ok: true },
      { session_id: 'missing', ok: false },
      { session_id: 'two', ok: true },
    ])
    expect(prompts.map(([id]) => id)).toEqual(['one', 'two'])
  })

  it('serializes concurrent replies so the thread limit cannot be exceeded', async () => {
    const { host, append } = fakeHost()
    append({
      type: 'session.created',
      sessionId: 'peer',
      at: 0,
      title: 'Peer',
      cwd: '/p',
      projectPath: '/p',
      instanceId: 'codex',
      agentTools: true,
    })
    for (let i = 0; i < 49; i++) {
      for (const sessionId of ['parent', 'peer'])
        append({
          type: 'agent.message',
          sessionId,
          at: i,
          messageId: String(i),
          threadId: 'thread',
          senderId: 'parent',
          recipientId: 'peer',
          text: 'x',
        })
    }
    const t = tools(host)
    const results = await Promise.allSettled([
      call(t, 'parent', 'send_peer_message', {
        session_id: 'peer',
        thread_id: 'thread',
        text: 'a',
      }),
      call(t, 'peer', 'send_peer_message', {
        session_id: 'parent',
        thread_id: 'thread',
        text: 'b',
      }),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
  })
  it('records a reply in both inboxes and rejects replies to an unrelated thread', async () => {
    const { host, append } = fakeHost()
    append({
      type: 'session.created',
      sessionId: 'peer',
      at: 0,
      title: 'Peer',
      cwd: '/p',
      projectPath: '/p',
      instanceId: 'codex',
      agentTools: true,
    })
    const t = tools(host)
    const sent = await call(t, 'parent', 'send_peer_message', {
      session_id: 'peer',
      text: 'Question',
    })
    await call(t, 'peer', 'send_peer_message', {
      session_id: 'parent',
      text: 'Answer',
      thread_id: sent.thread_id,
    })
    const inbox = (await call(t, 'parent', 'read_peer_inbox', {})) as unknown as {
      thread_id: string
      text: string
    }[]
    expect(inbox.map((m) => m.text)).toEqual(['Question', 'Answer'])
    expect(inbox.every((m) => m.thread_id === sent.thread_id)).toBe(true)
    await expect(
      call(t, 'peer', 'send_peer_message', {
        session_id: 'parent',
        text: 'x',
        thread_id: 'unknown',
      }),
    ).rejects.toThrow('Thread')
  })

  it('stops a thread after 50 recorded messages', async () => {
    const { host, append } = fakeHost()
    append({
      type: 'session.created',
      sessionId: 'peer',
      at: 0,
      title: 'Peer',
      cwd: '/p',
      projectPath: '/p',
      instanceId: 'codex',
      agentTools: true,
    })
    for (let i = 0; i < 50; i++)
      append({
        type: 'agent.message',
        sessionId: 'parent',
        at: i,
        messageId: String(i),
        threadId: 'thread',
        senderId: 'parent',
        recipientId: 'peer',
        text: 'x',
      })
    await expect(
      call(tools(host), 'parent', 'send_peer_message', {
        session_id: 'peer',
        text: 'x',
        thread_id: 'thread',
      }),
    ).rejects.toThrow('Thread message limit')
  })
  it('discovers and messages opted-in peers only within the same project', async () => {
    const { host, append, prompts } = fakeHost()
    const t = tools(host)
    const add = (sessionId: string, projectPath: string, agentTools: boolean) =>
      append({
        type: 'session.created',
        sessionId,
        at: 0,
        title: sessionId,
        cwd: projectPath,
        projectPath,
        instanceId: 'codex',
        agentTools,
      })
    add('peer', '/p', true)
    add('private', '/p', false)
    add('other', '/other', true)
    const peers = (await call(t, 'parent', 'list_peer_sessions', {})) as unknown as {
      session_id: string
    }[]
    expect(peers.map((p) => p.session_id)).toEqual(['peer'])
    await expect(
      call(t, 'parent', 'send_peer_message', { session_id: 'other', text: 'hello' }),
    ).rejects.toThrow('Recipient')
    await expect(
      call(t, 'parent', 'send_peer_message', { session_id: 'private', text: 'hello' }),
    ).rejects.toThrow('Recipient')
    expect(
      await call(t, 'parent', 'send_peer_message', { session_id: 'peer', text: 'hello' }),
    ).toMatchObject({ state: 'queued' })
    expect(prompts[0]?.[0]).toBe('peer')
    expect(prompts[0]?.[1]).toContain('Message from agent claude (session parent, "Parent")')
    expect(prompts[0]?.[1]).toContain('\n\nhello')
    append({ type: 'session.deleted', sessionId: 'peer', at: 1 })
    await expect(
      call(t, 'parent', 'send_peer_message', { session_id: 'peer', text: 'hello' }),
    ).rejects.toThrow('Recipient')
  })

  it('limits peer sends across a project and rejects oversized messages', async () => {
    const { host, append } = fakeHost()
    const t = tools(host)
    append({
      type: 'session.created',
      sessionId: 'peer',
      at: 0,
      title: 'Peer',
      cwd: '/p',
      projectPath: '/p',
      instanceId: 'codex',
      agentTools: true,
    })
    await expect(
      call(t, 'parent', 'send_peer_message', { session_id: 'peer', text: 'x'.repeat(8001) }),
    ).rejects.toThrow('8000')
    for (let i = 0; i < 10; i++)
      await call(t, 'parent', 'send_peer_message', { session_id: 'peer', text: 'hello' })
    await expect(
      call(t, 'peer', 'send_peer_message', { session_id: 'parent', text: 'reply' }),
    ).rejects.toThrow('limit')
  })
  it('exposes design tools during provider startup before session.created is recorded', async () => {
    const { host, append } = fakeHost()
    const t = new AgentTools(
      host,
      { file: '/bridge.mjs', url: () => 'http://127.0.0.1:1/agent-tools' },
      undefined,
      {} as DesignTools,
    )
    t.serversFor('starting', { designTools: true })
    const names = (
      (await t.handle('starting', 'tools/list', {})) as { tools: { name: string }[] }
    ).tools.map((tool) => tool.name)
    expect(names).toContain('design_add')
    expect(names).not.toContain('start_session')
    expect(await t.handle('starting', 'instructions', {})).toContain(
      'editable design on the open BeddCode canvas',
    )
    append({
      type: 'session.created',
      sessionId: 'starting',
      at: 0,
      title: 'Design',
      cwd: '/p',
      instanceId: 'claude',
      designTools: true,
    })
    expect(
      ((await t.handle('starting', 'tools/list', {})) as { tools: { name: string }[] }).tools.map(
        (tool) => tool.name,
      ),
    ).toContain('design_add')
  })

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
    // The deepest level cannot start sessions, but can message peers and report.
    expect(await names('child-2')).toEqual([
      'set_peer_group',
      'list_peer_groups',
      'list_peer_sessions',
      'send_peer_message',
      'read_peer_inbox',
      'broadcast_peer_message',
      'report_result',
    ])

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

  it('waits on several sessions: the first to finish, or all of them', async () => {
    const { host, append } = fakeHost()
    const t = tools(host)
    for (const prompt of ['a', 'b', 'c'])
      await call(t, 'parent', 'start_session', { agent: 'codex', prompt })
    const ids = ['child-1', 'child-2', 'child-3']
    const done = (id: string) =>
      append({ type: 'turn.completed', sessionId: id, at: Date.now(), reason: 'done' })

    const any = call(t, 'parent', 'wait_for', { session_ids: ids, timeout_seconds: 5 })
    done('child-2')
    const first = (await any) as {
      sessions: { session_id: string; done: boolean }[]
      done: boolean
    }
    expect(first.done).toBe(false)
    expect(first.sessions.map((s) => [s.session_id, s.done])).toEqual([
      ['child-1', false],
      ['child-2', true],
      ['child-3', false],
    ])

    const all = call(t, 'parent', 'wait_for', { session_ids: ids, mode: 'all', timeout_seconds: 5 })
    done('child-1')
    await new Promise((r) => setTimeout(r, 120))
    done('child-3')
    expect(await all).toMatchObject({ done: true, data_notice: expect.stringContaining('data') })

    // One that needs the user does not hold the others up forever.
    await call(t, 'parent', 'send_message', { session_id: 'child-1', text: 'again' })
    await call(t, 'parent', 'send_message', { session_id: 'child-2', text: 'again' })
    const early = call(t, 'parent', 'wait_for', {
      session_ids: ['child-1', 'child-2'],
      mode: 'all',
      timeout_seconds: 5,
    })
    append({
      type: 'approval.requested',
      sessionId: 'child-2',
      at: Date.now(),
      requestId: 'r',
      title: 'Run it?',
      options: [],
    })
    const woke = (await early) as { done: boolean; sessions: { status: string }[] }
    expect(woke.done).toBe(false)
    expect(woke.sessions.map((s) => s.status)).toEqual(['running', 'needs-you'])

    await expect(call(t, 'parent', 'wait_for', { session_ids: ['parent'] })).rejects.toThrow(
      /not a session you started/,
    )
  })

  it('says plainly when a finished session never reported, and falls back to its reply', async () => {
    const { host, append } = fakeHost()
    const t = tools(host)
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'go' })
    append({
      type: 'message.delta',
      sessionId: 'child-1',
      at: 0,
      role: 'assistant',
      text: 'All done.',
    })
    append({ type: 'turn.completed', sessionId: 'child-1', at: 0, reason: 'done' })
    const out = await call(t, 'parent', 'wait_for', { session_id: 'child-1' })
    expect(out).toMatchObject({
      done: true,
      reported: 'none',
      reply: 'All done.',
      note: expect.stringContaining('report_result'),
    })
    expect(out).not.toHaveProperty('result')
  })

  it('shows which sessions changed the same files, ignoring undone changes', async () => {
    const { host, append } = fakeHost()
    const t = tools(host)
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'a' })
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'b' })
    await call(t, 'parent', 'start_session', { agent: 'codex', prompt: 'c' })
    const changed = (id: string, after: string, ...paths: string[]) =>
      append({
        type: 'turn.changes',
        sessionId: id,
        at: 0,
        before: 'b',
        after,
        files: paths.map((path) => ({ path, status: 'M', added: 1, removed: 0 })),
      } as never)
    changed('child-1', 'x1', 'src/a.ts', 'src/only1.ts')
    changed('child-2', 'x2', 'src/a.ts')
    changed('child-3', 'x3', 'src/other.ts')

    const status = (id: string) => call(t, 'parent', 'get_status', { session_id: id })
    expect(await status('child-1')).toMatchObject({
      overlaps: [{ session_id: 'child-2', files: ['src/a.ts'] }],
    })
    expect(await status('child-3')).not.toHaveProperty('overlaps')
    const listed = (await call(t, 'parent', 'list_children', {})) as unknown as {
      session_id: string
      overlaps?: unknown
    }[]
    expect(listed.filter((c) => c.overlaps).map((c) => c.session_id)).toEqual([
      'child-1',
      'child-2',
    ])

    append({ type: 'turn.reverted', sessionId: 'child-2', at: 0, after: 'x2' })
    expect(await status('child-1')).not.toHaveProperty('overlaps')
  })

  it('has another agent review a session’s work, read only, with the changes in its prompt', async () => {
    const { host, created, prompts } = fakeHost()
    host.providers = async () => [
      CODEX,
      provider('claude', [
        { id: 'default', label: 'Ask before edits' },
        { id: 'plan', label: 'Plan mode' },
      ]),
    ]
    const t = tools(host)
    await call(t, 'parent', 'start_session', {
      agent: 'codex',
      prompt: 'build it',
      title: 'Builder',
    })
    const reviewed = await call(t, 'parent', 'review_changes', {
      session_id: 'child-1',
      focus: 'error handling',
    })
    expect(reviewed).toMatchObject({
      session_id: 'child-2',
      reviewing: 'child-1',
      agent: 'claude',
      mode: 'plan',
    })
    expect(created[1]!.params).toMatchObject({ instanceId: 'claude', permissionMode: 'plan' })
    const prompt = prompts.find(([id]) => id === 'child-2')![1]
    expect(prompt).toContain('Do not change any files')
    expect(prompt).toContain('Focus on: error handling')
    expect(prompt).toContain('+changed line')
    await expect(call(t, 'child-1', 'review_changes', { session_id: 'parent' })).rejects.toThrow(
      /not a session you started/,
    )
    await expect(
      call(t, 'parent', 'review_changes', { session_id: 'child-1', agent: 'nobody' }),
    ).rejects.toThrow(/No agent/)
  })

  it('tells agents to use the exact, possibly prefixed, tool names', async () => {
    const t = tools(fakeHost().host)
    expect(await t.handle('parent', 'instructions', {})).toContain('beddcode__start_session')
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
