import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayHost, type GatewayHostOptions } from './host.ts'
import { createFakeAdapter } from '@beddcode/provider-core'
import { createLogger } from '@beddcode/shared'
import { EventStore } from '../store/eventStore.ts'
import { SessionManager } from '../sessions/sessionManager.ts'
import { AttachmentStore } from '../attachments/store.ts'
import { GitService } from '../workspace/git.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'beddcode-mcp-test-'))
  dirs.push(home)
  const sessions = {
    listProviders: vi.fn().mockResolvedValue([
      {
        id: 'fake',
        label: 'Fake',
        status: 'ready',
        capabilities: { permissionModes: [{ id: 'ask', label: 'Ask' }], models: [] },
      },
    ]),
    create: vi.fn().mockResolvedValue({ sessionId: 'created' }),
    prompt: vi.fn().mockResolvedValue({ state: 'started' }),
    interrupt: vi.fn(),
    answerQuestion: vi.fn(),
    approve: vi.fn(),
    previewAgent: vi
      .fn()
      .mockResolvedValue({ modes: [{ id: 'ask', label: 'Ask' }], config: [], commands: [] }),
    setModel: vi.fn(),
    setConfig: vi.fn(),
    setMode: vi.fn(),
    rename: vi.fn(),
    setDone: vi.fn(),
  }
  const options = {
    url: 'wss://example.test/host',
    secret: 'secret',
    projects: async () => [path.resolve(home), path.join(home, 'other')],
    home,
    sessions,
    store: { readSession: () => [], listSessionIds: () => [] },
    log: {},
  } as unknown as GatewayHostOptions
  return { host: new GatewayHost(options), sessions, options }
}

describe('MCP gateway host', () => {
  it('starts in the chosen project using an asking mode and persists its session scope', async () => {
    const { host, sessions, options } = setup()
    await expect(
      host.call('start_session', {
        agent: 'fake',
        prompt: 'Investigate',
        project: options.home,
        worktree: true,
        folder: '/ignored',
      }),
    ).resolves.toEqual({ session_id: 'created' })
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: options.home,
        permissionMode: 'ask',
        workspace: { mode: 'worktree' },
      }),
      { mcpGateway: true },
    )
    await new GatewayHost(options).call('send_message', { session_id: 'created', text: 'Continue' })
    expect(sessions.prompt).toHaveBeenLastCalledWith('created', 'Continue')
  })

  it('refuses unknown sessions and agents without a limited mode', async () => {
    const { host, sessions, options } = setup()
    await expect(host.call('send_message', { session_id: 'other', text: 'hello' })).rejects.toThrow(
      'Session not found',
    )
    sessions.listProviders.mockResolvedValue([
      { id: 'fake', status: 'ready', capabilities: { permissionModes: [] } },
    ])
    await expect(
      host.call('start_session', { agent: 'fake', prompt: 'hello', project: options.home }),
    ).rejects.toThrow('permission mode')
    expect(sessions.create).not.toHaveBeenCalled()
  })

  it('lists projects and only starts sessions in added projects', async () => {
    const { host, sessions, options } = setup()
    const projects = await options.projects()
    await expect(
      host.call('start_session', { agent: 'fake', prompt: 'Investigate' }),
    ).rejects.toThrow('Invalid project')
    await expect(host.call('list_projects', {})).resolves.toEqual({
      projects,
    })
    await host.call('start_session', { agent: 'fake', prompt: 'Investigate', project: projects[1] })
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: projects[1] }), {
      mcpGateway: true,
    })
    await expect(
      host.call('start_session', {
        agent: 'fake',
        prompt: 'Investigate',
        project: path.join(options.home, 'elsewhere'),
      }),
    ).rejects.toThrow('not added')
  })

  it('reports when a session was created but its first prompt failed', async () => {
    const { host, sessions, options } = setup()
    sessions.prompt.mockRejectedValueOnce(new Error('disconnected'))
    await expect(
      host.call('start_session', { agent: 'fake', prompt: 'hello', project: options.home }),
    ).rejects.toThrow('Session created was created')
  })

  it('discovers agent settings and starts with the chosen model, effort, and mode', async () => {
    const { host, sessions, options } = setup()
    sessions.listProviders.mockResolvedValue([
      {
        id: 'fake',
        label: 'Fake',
        status: 'ready',
        capabilities: {
          models: [{ id: 'model-a', label: 'Model A', efforts: ['low', 'high'] }],
          efforts: ['low'],
          permissionModes: [
            { id: 'ask', label: 'Ask' },
            { id: 'plan', label: 'Plan' },
            { id: 'full', label: 'Full access', dangerous: true },
          ],
        },
      },
    ])
    sessions.previewAgent.mockResolvedValue({
      modes: [{ id: 'ask', label: 'Ask' }],
      config: [{ id: 'web', name: 'Web', type: 'boolean', value: false }],
      commands: [{ name: 'review', kind: 'command' }],
    })
    expect(
      await host.call('get_agent_options', { agent: 'fake', project: options.home }),
    ).toMatchObject({
      models: [{ id: 'model-a' }],
      config: [{ id: 'web' }],
      commands: [{ name: 'review' }],
    })
    await host.call('start_session', {
      agent: 'fake',
      project: options.home,
      prompt: 'hello',
      model: 'model-a',
      effort: 'high',
      mode: 'plan',
      config: { web: true },
    })
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'model-a',
        effort: 'high',
        permissionMode: 'plan',
        config: { web: true },
      }),
      { mcpGateway: true },
    )
    await expect(
      host.call('start_session', {
        agent: 'fake',
        project: options.home,
        prompt: 'hello',
        mode: 'full',
      }),
    ).rejects.toThrow('asking or read-only')
    await expect(
      host.call('start_session', {
        agent: 'fake',
        project: options.home,
        prompt: 'hello',
        model: 'model-a',
        effort: 'impossible',
      }),
    ).rejects.toThrow('Effort')
  })

  it('routes ACP start model and effort to the advertised configuration IDs', async () => {
    const { host, sessions, options } = setup()
    sessions.listProviders.mockResolvedValue([
      {
        id: 'fake',
        kind: 'acp',
        label: 'Fake',
        status: 'ready',
        capabilities: { permissionModes: [{ id: 'ask', label: 'Ask' }] },
      },
    ])
    sessions.previewAgent.mockResolvedValue({
      modes: [{ id: 'ask', label: 'Ask' }],
      commands: [],
      config: [
        { id: 'model_id', category: 'model', type: 'select', choices: [{ value: 'fast' }] },
        {
          id: 'thinking_level',
          category: 'thought_level',
          type: 'select',
          choices: [{ value: 'high' }],
        },
      ],
    })
    await host.call('start_session', {
      agent: 'fake',
      project: options.home,
      prompt: 'hello',
      model: 'fast',
      effort: 'high',
    })
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ config: { model_id: 'fast', thinking_level: 'high' } }),
      { mcpGateway: true },
    )
  })

  it('changes supported model, effort, settings and modes, and organizes sessions', async () => {
    const { host, sessions, options } = setup()
    sessions.listProviders.mockResolvedValue([
      {
        id: 'fake',
        status: 'ready',
        capabilities: {
          models: [{ id: 'fast', label: 'Fast', efforts: ['low', 'high'] }],
          permissionModes: [{ id: 'ask', label: 'Ask' }],
        },
      },
    ])
    options.store.readSession = () =>
      [
        {
          seq: 1,
          event: {
            type: 'session.created',
            sessionId: 'local',
            instanceId: 'fake',
            model: 'fast',
            effort: 'low',
          },
        },
        {
          seq: 2,
          event: {
            type: 'session.config',
            options: [{ id: 'web', type: 'boolean', value: false }],
          },
        },
        { seq: 3, event: { type: 'session.commands', commands: [{ name: 'review' }] } },
      ] as never
    expect(await host.call('get_session_options', { session_id: 'local' })).toMatchObject({
      model: 'fast',
      effort: 'low',
      commands: [{ name: 'review' }],
    })
    await host.call('set_session_model', { session_id: 'local', effort: 'high' })
    expect(sessions.setModel).toHaveBeenCalledWith('local', 'fast', 'high')
    await host.call('set_session_config', { session_id: 'local', option_id: 'web', value: true })
    expect(sessions.setConfig).toHaveBeenCalledWith('local', 'web', true)
    await host.call('set_session_mode', { session_id: 'local', mode: 'ask' })
    expect(sessions.setMode).toHaveBeenCalledWith('local', 'ask')
    await host.call('rename_session', { session_id: 'local', title: '  Review  ' })
    await host.call('set_session_done', { session_id: 'local', done: true })
    expect(sessions.rename).toHaveBeenCalledWith('local', 'Review')
    expect(sessions.setDone).toHaveBeenCalledWith('local', true)
    await expect(
      host.call('set_session_config', { session_id: 'local', option_id: 'web', value: 'yes' }),
    ).rejects.toThrow('Value')
  })

  it('changes ACP model and effort using live configuration choices', async () => {
    const { host, sessions, options } = setup()
    options.store.readSession = () =>
      [
        { seq: 1, event: { type: 'session.created', sessionId: 'local', instanceId: 'fake' } },
        {
          seq: 2,
          event: {
            type: 'session.config',
            options: [
              { id: 'model_id', category: 'model', type: 'select', choices: [{ value: 'smart' }] },
              {
                id: 'thinking_level',
                category: 'thought_level',
                type: 'select',
                choices: [{ value: 'high' }],
              },
            ],
          },
        },
      ] as never
    await host.call('set_session_model', { session_id: 'local', model: 'smart', effort: 'high' })
    expect(sessions.setConfig.mock.calls).toEqual([
      ['local', 'model_id', 'smart'],
      ['local', 'thinking_level', 'high'],
    ])
    expect(sessions.setModel).not.toHaveBeenCalled()
  })

  it('reports a partial change if the model changes but the effort fails', async () => {
    const { host, sessions, options } = setup()
    options.store.readSession = () =>
      [
        { seq: 1, event: { type: 'session.created', sessionId: 'local', instanceId: 'fake' } },
        {
          seq: 2,
          event: {
            type: 'session.config',
            options: [
              { id: 'model', category: 'model', type: 'select', choices: [{ value: 'smart' }] },
              {
                id: 'thinking_level',
                category: 'thought_level',
                type: 'select',
                choices: [{ value: 'high' }],
              },
            ],
          },
        },
      ] as never
    sessions.setConfig
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Not supported'))
    await expect(
      host.call('set_session_model', { session_id: 'local', model: 'smart', effort: 'high' }),
    ).rejects.toThrow('Model changed, but effort could not be changed')
  })

  it('uses the real session manager to start and update an agent session', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'beddcode-mcp-real-'))
    dirs.push(home)
    const store = new EventStore(':memory:')
    const log = createLogger('test', 'error')
    const manager = new SessionManager({
      store,
      log,
      defaultCwd: home,
      attachments: new AttachmentStore(path.join(home, 'attachments')),
      git: new GitService(),
      adapters: [createFakeAdapter({ advanced: true, delayMs: 0 })],
    })
    const host = new GatewayHost({
      url: 'wss://example.test/host',
      secret: 'secret',
      home,
      sessions: manager,
      store,
      log,
      projects: async () => [home],
    })
    try {
      const started = (await host.call('start_session', {
        agent: 'fake',
        project: home,
        prompt: 'hello',
        model: 'fast',
        mode: 'ask',
      })) as { session_id: string }
      expect(
        await host.call('get_session_options', { session_id: started.session_id }),
      ).toMatchObject({ model: 'fast' })
      await host.call('set_session_model', { session_id: started.session_id, model: 'smart' })
      await host.call('rename_session', { session_id: started.session_id, title: 'New title' })
      await host.call('set_session_done', { session_id: started.session_id, done: true })
      expect(store.readSession(started.session_id).map(({ event }) => event)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'session.model', model: 'smart' }),
          expect.objectContaining({ type: 'session.renamed', title: 'New title' }),
          expect.objectContaining({ type: 'session.done', done: true }),
        ]),
      )
    } finally {
      await manager.close()
      store.close()
    }
  })

  it('lists and reads existing local sessions with a resumable event cursor', async () => {
    const { host, options } = setup()
    const events = [
      {
        seq: 1,
        event: {
          type: 'session.created',
          sessionId: 'local',
          title: 'Local',
          instanceId: 'fake',
          cwd: options.home,
          at: 1,
        },
      },
      {
        seq: 2,
        event: {
          type: 'message.delta',
          sessionId: 'local',
          role: 'assistant',
          text: 'hello',
          at: 2,
        },
      },
    ]
    options.store.listSessionIds = () => [{ id: 'local', latest: 2 }]
    options.store.readSession = () => events as never
    expect(await host.call('list_sessions', {})).toMatchObject({
      sessions: [{ sessionId: 'local', title: 'Local' }],
    })
    const page = await host.call('get_session_events', { session_id: 'local', limit: 1 })
    expect(page).toMatchObject({ events: [events[0]], next_cursor: 1, has_more: true })
    expect(await host.call('get_session_events', { session_id: 'local', cursor: 1 })).toMatchObject(
      { events: [events[1]], next_cursor: 2, has_more: false },
    )
  })

  it('answers questions and resolves only individual pending approvals', async () => {
    const { host, options, sessions } = setup()
    options.store.readSession = () =>
      [
        { seq: 1, event: { type: 'session.created', sessionId: 'local' } },
        {
          seq: 2,
          event: {
            type: 'question.requested',
            requestId: 'q',
            questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'Yes' }] }],
          },
        },
        {
          seq: 3,
          event: {
            type: 'approval.requested',
            requestId: 'a',
            title: 'Run',
            options: [
              { id: 'once', label: 'Allow once', kind: 'allow' },
              { id: 'always', label: 'Always allow', kind: 'allow' },
              { id: 'no', label: 'Reject', kind: 'deny' },
            ],
          },
        },
      ] as never
    expect(await host.call('get_pending_requests', { session_id: 'local' })).toMatchObject({
      requests: [{ requestId: 'q' }, { requestId: 'a' }],
    })
    await expect(
      host.call('answer_question', {
        session_id: 'local',
        request_id: 'q',
        answers: { choice: ['Wrong'] },
      }),
    ).rejects.toThrow('available choice')
    await host.call('answer_question', {
      session_id: 'local',
      request_id: 'q',
      answers: { choice: ['Yes'] },
    })
    expect(sessions.answerQuestion).toHaveBeenCalledWith('local', 'q', { choice: ['Yes'] })
    await expect(
      host.call('resolve_approval', { session_id: 'local', request_id: 'a', option_id: 'always' }),
    ).rejects.toThrow('persistent')
    await host.call('resolve_approval', { session_id: 'local', request_id: 'a', option_id: 'once' })
    expect(sessions.approve).toHaveBeenCalledWith('local', 'a', 'once')
    options.allowApprovals = () => false
    await expect(
      host.call('resolve_approval', { session_id: 'local', request_id: 'a', option_id: 'no' }),
    ).rejects.toThrow('disabled')
  })

  it('reads files only within a selected project and honors the access toggle', async () => {
    const { host, options } = setup()
    writeFileSync(path.join(options.home, 'note.txt'), 'hello')
    expect(
      await host.call('read_project_file', { project: options.home, path: 'note.txt' }),
    ).toMatchObject({ content: 'hello' })
    await expect(
      host.call('read_project_file', { project: options.home, path: '../outside' }),
    ).rejects.toThrow()
    options.allowProjectRead = () => false
    await expect(
      host.call('read_project_file', { project: options.home, path: 'note.txt' }),
    ).rejects.toThrow('disabled')
  })

  it('limits Git status and diffs to an added project inside a larger repository', async () => {
    const { options } = setup()
    const project = path.join(options.home, 'project')
    mkdirSync(project)
    execFileSync('git', ['init', '-q'], { cwd: options.home })
    writeFileSync(path.join(project, 'inside.txt'), 'inside')
    writeFileSync(path.join(options.home, 'outside.txt'), 'outside')
    options.projects = async () => [project]
    const host = new GatewayHost(options)
    const status = (await host.call('project_status', { project })) as { files: { path: string }[] }
    expect(status.files.map((file) => file.path)).toEqual(['inside.txt'])
    const diff = (await host.call('project_diff', { project, path: 'inside.txt' })) as {
      path: string
      patch: string
    }
    expect(diff.path).toBe('inside.txt')
    expect(diff.patch).toContain('inside')
    await expect(host.call('project_diff', { project, path: '../outside.txt' })).rejects.toThrow(
      'outside',
    )
  })
})
