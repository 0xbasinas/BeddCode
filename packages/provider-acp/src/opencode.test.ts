import { describe, expect, it } from 'vitest'
import { createLogger, type Transport } from '@beddcode/shared'
import { createOpenCodeAdapter, opencodeCapabilities } from './opencode.ts'
import type { SessionEvent } from '@beddcode/contracts'

type Message = { id?: number; method?: string; params?: Record<string, any>; result?: any }
function fakeOpenCode() {
  let onLine: (line: string) => void = () => {}
  let onClose: () => void = () => {}
  const messages: Message[] = []
  const capabilities = {
    sessionCapabilities: { resume: {}, list: {}, fork: {} },
    promptCapabilities: { image: true },
  }
  const transport: Transport = {
    send(line) {
      const message = JSON.parse(line) as Message
      messages.push(message)
      if (message.id === undefined || !message.method) return
      const result =
        message.method === 'initialize'
          ? { protocolVersion: 1, agentCapabilities: capabilities }
          : message.method === 'session/new'
            ? {
                sessionId: 'oc-1',
                configOptions: [
                  {
                    id: 'model',
                    name: 'Model',
                    category: 'model',
                    type: 'select',
                    currentValue: 'anthropic/sonnet',
                    options: [{ value: 'anthropic/sonnet', name: 'Sonnet' }],
                  },
                  {
                    id: 'mode',
                    name: 'Session Mode',
                    category: 'mode',
                    type: 'select',
                    currentValue: 'build',
                    options: [
                      { value: 'build', name: 'Build' },
                      { value: 'plan', name: 'Plan' },
                    ],
                  },
                ],
              }
            : message.method === 'session/resume'
              ? { configOptions: [] }
              : message.method === 'session/prompt'
                ? {
                    stopReason: 'end_turn',
                    _meta: {
                      usage: {
                        inputTokens: 40,
                        outputTokens: 12,
                        cachedReadTokens: 10,
                        costUsd: 0.002,
                      },
                      modelId: 'anthropic/sonnet',
                    },
                  }
                : message.method === 'session/fork'
                  ? { sessionId: 'oc-fork' }
                  : {}
      queueMicrotask(() => onLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })))
    },
    onLine(handler) {
      onLine = handler
    },
    onClose(handler) {
      onClose = handler
    },
    close() {
      onClose()
    },
  }
  return {
    transport,
    messages,
  }
}

describe('OpenCode adapter', () => {
  it('advertises documented ACP session features', () => {
    expect(opencodeCapabilities).toMatchObject({
      resume: true,
      fork: true,
      usage: true,
      questions: true,
      commands: true,
      history: true,
      mcp: false,
    })
  })

  it('detects when the OpenCode executable is missing', async () => {
    const [instance] = await createOpenCodeAdapter({
      executablePath: 'C:/missing/opencode',
    }).detect()
    expect(instance).toMatchObject({
      id: 'opencode',
      kind: 'opencode',
      label: 'OpenCode',
      status: 'not-installed',
    })
  })

  it('launches the installed CLI in ACP mode', async () => {
    let launch: { executable: string; args: string[]; cwd: string } | undefined
    const transport: Transport = {
      send() {},
      onLine() {},
      onClose() {},
      close() {},
    }
    const adapter = createOpenCodeAdapter({
      executablePath: process.execPath,
      log: createLogger('test', 'error'),
      createTransport(executable, args, cwd) {
        launch = { executable, args, cwd }
        return transport
      },
    })
    const session = await adapter.startSession('opencode', { sessionId: 's1', cwd: '/work' })
    expect(launch).toEqual({ executable: process.execPath, args: ['acp'], cwd: '/work' })
    expect(session).toBeDefined()
    await session.close()
  })

  it('exposes OpenCode model and mode settings and resumes stored sessions over ACP', async () => {
    const agent = fakeOpenCode()
    const adapter = createOpenCodeAdapter({
      executablePath: process.execPath,
      log: createLogger('test', 'error'),
      createTransport: () => agent.transport,
    })
    const session = await adapter.startSession('opencode', { sessionId: 's1', cwd: '/work' })
    const events: SessionEvent[] = []
    const consuming = (async () => {
      for await (const event of session.events) events.push(event)
    })()
    for (let i = 0; i < 20 && !events.some((event) => event.type === 'session.config'); i++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'session.provider-session', providerSessionId: 'oc-1' }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'session.config',
        options: expect.arrayContaining([
          expect.objectContaining({ id: 'model', category: 'model' }),
        ]),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'session.modes',
        currentModeId: 'build',
        modes: expect.arrayContaining([expect.objectContaining({ id: 'plan' })]),
      }),
    )
    await session.close()
    await consuming

    const resumed = await adapter.startSession('opencode', {
      sessionId: 's2',
      cwd: '/work',
      resumeId: 'oc-old',
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(
      agent.messages.find((message) => message.method === 'session/resume')?.params,
    ).toMatchObject({ sessionId: 'oc-old', cwd: '/work' })
    await resumed.close()
  })

  it('previews models and modes delivered in OpenCode config notifications', async () => {
    let onLine: (line: string) => void = () => {}
    let onClose: () => void = () => {}
    const messages: Message[] = []
    const transport: Transport = {
      send(line) {
        const message = JSON.parse(line) as Message
        messages.push(message)
        const reply = (result: unknown) =>
          onLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
        if (message.method === 'initialize')
          queueMicrotask(() =>
            reply({
              protocolVersion: 1,
              agentCapabilities: { sessionCapabilities: { close: {} } },
            }),
          )
        if (message.method === 'session/new')
          queueMicrotask(() => {
            onLine(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'oc-1',
                  update: {
                    sessionUpdate: 'config_option_update',
                    configOptions: [
                      {
                        id: 'model',
                        name: 'Model',
                        category: 'model',
                        type: 'select',
                        currentValue: 'google/gemini',
                        options: [{ value: 'google/gemini', name: 'Gemini' }],
                      },
                      {
                        id: 'mode',
                        name: 'Mode',
                        category: 'mode',
                        type: 'select',
                        currentValue: 'build',
                        options: [
                          { value: 'build', name: 'Build' },
                          { value: 'plan', name: 'Plan' },
                        ],
                      },
                    ],
                  },
                },
              }),
            )
            reply({ sessionId: 'oc-1', configOptions: [] })
          })
        if (message.method === 'session/close') queueMicrotask(() => reply({}))
      },
      onLine(handler) {
        onLine = handler
      },
      onClose(handler) {
        onClose = handler
      },
      close() {
        onClose()
      },
    }
    const adapter = createOpenCodeAdapter({
      executablePath: process.execPath,
      log: createLogger('test', 'error'),
      createTransport: () => transport,
    })
    const preview = await adapter.preview?.('opencode', '/work')
    expect(preview?.config).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'model',
          value: 'google/gemini',
          choices: [expect.objectContaining({ value: 'google/gemini' })],
        }),
      ]),
    )
    expect(preview?.modes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'build' }),
        expect.objectContaining({ id: 'plan' }),
      ]),
    )
  })

  it('applies the selected model before its effort, honoring explicit config', async () => {
    const agent = fakeOpenCode()
    const adapter = createOpenCodeAdapter({
      executablePath: process.execPath,
      log: createLogger('test', 'error'),
      createTransport: () => agent.transport,
    })
    const session = await adapter.startSession('opencode', {
      sessionId: 'selected',
      cwd: '/work',
      model: 'provider/old',
      effort: 'low',
      config: { model: 'provider/new', effort: 'high' },
    })
    await session.prompt({ text: 'hello' })
    expect(
      agent.messages
        .filter((message) => message.method === 'session/set_config_option')
        .map((message) => message.params),
    ).toEqual([
      expect.objectContaining({ configId: 'model', value: 'provider/new' }),
      expect.objectContaining({ configId: 'effort', value: 'high' }),
    ])
    await session.close()
  })

  it('passes the BeddCode MCP gateway servers into new OpenCode sessions', async () => {
    const agent = fakeOpenCode()
    const adapter = createOpenCodeAdapter({
      executablePath: process.execPath,
      log: createLogger('test', 'error'),
      createTransport: () => agent.transport,
    })
    const session = await adapter.startSession('opencode', {
      sessionId: 's-mcp',
      cwd: '/work',
      mcpServers: [
        {
          name: 'beddcode',
          command: process.execPath,
          args: ['gateway'],
          env: { TOKEN: 'secret' },
        },
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(
      agent.messages.find((message) => message.method === 'session/new')?.params?.mcpServers,
    ).toEqual([
      {
        name: 'beddcode',
        command: process.execPath,
        args: ['gateway'],
        env: [{ name: 'TOKEN', value: 'secret' }],
      },
    ])
    await session.close()
  })

  it('reports OpenCode turn usage', async () => {
    const agent = fakeOpenCode()
    const adapter = createOpenCodeAdapter({
      executablePath: process.execPath,
      log: createLogger('test', 'error'),
      createTransport: () => agent.transport,
    })
    const session = await adapter.startSession('opencode', { sessionId: 's1', cwd: '/work' })
    const events: SessionEvent[] = []
    const consuming = (async () => {
      for await (const event of session.events) events.push(event)
    })()
    await session.prompt({ text: 'hello' })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'session.usage',
        model: 'anthropic/sonnet',
        inputTokens: 30,
        cacheReadTokens: 10,
        outputTokens: 12,
        costUsd: 0.002,
      }),
    )
    await session.close()
    await consuming
  })

  it('forks an earlier OpenCode session through ACP', async () => {
    const agent = fakeOpenCode()
    const adapter = createOpenCodeAdapter({
      executablePath: process.execPath,
      log: createLogger('test', 'error'),
      createTransport: () => agent.transport,
    })
    await expect(
      adapter.forkHistory?.('opencode', { providerSessionId: 'oc-old', cwd: '/work' }),
    ).resolves.toBe('oc-fork')
    expect(
      agent.messages.find((message) => message.method === 'session/fork')?.params,
    ).toMatchObject({ sessionId: 'oc-old', cwd: '/work' })
  })
})
