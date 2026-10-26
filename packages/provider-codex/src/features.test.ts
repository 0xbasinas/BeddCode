import { describe, expect, it, vi } from 'vitest'
import { createLogger, type Transport } from '@beddcode/shared'
import { createCodexAdapter } from './adapter.ts'
import {
  createCodexHistory,
  createWithAppServer,
  skillsToCommands,
  turnEvents,
  turnText,
} from './history.ts'
import { addArgs, createCodexMcp, parseMcpJson } from './mcp.ts'

const log = createLogger('test', 'error')

/** A throwaway app-server that answers by method name and records what it was asked. */
function scriptedTransport(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const sent: { method: string; params: Record<string, unknown> }[] = []
  let onLine: (line: string) => void = () => {}
  const transport: Transport = {
    send(line) {
      const msg = JSON.parse(line) as {
        id?: number
        method: string
        params?: Record<string, unknown>
      }
      if (msg.id === undefined) return
      sent.push({ method: msg.method, params: msg.params ?? {} })
      const handler = handlers[msg.method]
      const reply = handler
        ? { id: msg.id, result: handler(msg.params ?? {}) }
        : { id: msg.id, error: { code: -32601, message: `no ${msg.method}` } }
      queueMicrotask(() => onLine(JSON.stringify(reply)))
    },
    onLine: (h) => (onLine = h),
    onClose: () => {},
    close: vi.fn(),
  }
  return { transport, sent }
}

const turn = (id: string, user: string, assistant: string) => ({
  id,
  items: [
    { type: 'userMessage', id: `${id}-u`, content: [{ type: 'text', text: user }] },
    { type: 'reasoning', id: `${id}-r`, summary: ['thinking'], content: [] },
    { type: 'agentMessage', id: `${id}-a`, text: assistant },
  ],
})

describe('Codex history', () => {
  const thread = {
    id: 'th-1',
    preview: 'fix the build',
    updatedAt: 1_700_000_000,
    cwd: '/w',
    turns: [turn('t1', 'why?', 'because'), turn('t2', 'fix it', 'done')],
  }

  function history() {
    const server = scriptedTransport({
      initialize: () => ({}),
      'thread/list': () => ({
        data: [
          { id: 'old', preview: 'older', updatedAt: 5, cwd: '/w' },
          { id: 'th-1', name: 'Named', preview: 'fix', updatedAt: 9, cwd: '/w' },
        ],
      }),
      'thread/read': () => ({ thread }),
      'thread/fork': () => ({ thread: { id: 'forked' } }),
    })
    return {
      ...server,
      history: createCodexHistory(createWithAppServer(() => server.transport, log)),
    }
  }

  it('reduces a turn to what was said, ignoring reasoning and tools', () => {
    expect(turnText(turn('t', 'q', 'a'))).toEqual({ user: 'q', assistant: 'a' })
    expect(turnText({ items: [] })).toEqual({ user: '', assistant: '' })
  })

  it('lists newest first, converting seconds to milliseconds and preferring the name', async () => {
    const { history: h, sent } = history()
    expect(await h.list('/w')).toEqual([
      { id: 'th-1', title: 'Named', updatedAt: 9000, cwd: '/w' },
      { id: 'old', title: 'older', updatedAt: 5000, cwd: '/w' },
    ])
    expect(sent.find((m) => m.method === 'thread/list')?.params).toMatchObject({ cwd: '/w' })
  })

  it('reads a conversation turn by turn', async () => {
    const { history: h } = history()
    expect(await h.read('th-1', '/w')).toMatchObject([
      { user: 'why?', assistant: 'because', events: [{ type: 'message.delta', text: 'because' }] },
      { user: 'fix it', assistant: 'done', events: [{ type: 'message.delta', text: 'done' }] },
    ])
  })

  it('keeps the commands and messages of a stored turn in order', () => {
    const events = turnEvents(
      {
        items: [
          { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'run it' }] },
          {
            type: 'commandExecution',
            id: 'c',
            command: 'ls',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: 'a b',
          },
          { type: 'agentMessage', id: 'm', text: 'listed' },
        ],
      },
      '/w',
    )
    expect(events.map((e) => e.type)).toEqual(['tool.started', 'tool.completed', 'message.delta'])
    expect(events[1]).toMatchObject({ toolId: 'c', ok: true, output: 'a b' })
  })

  it('forks through a turn by its id, or the whole thread', async () => {
    const { history: h, sent } = history()
    expect(await h.fork('th-1', '/w', 1)).toBe('forked')
    expect(sent.filter((m) => m.method === 'thread/fork').at(-1)?.params).toMatchObject({
      threadId: 'th-1',
      lastTurnId: 't1',
      cwd: '/w',
    })
    await h.fork('th-1', '/w', 2)
    expect(sent.filter((m) => m.method === 'thread/fork').at(-1)?.params).not.toHaveProperty(
      'lastTurnId',
    )
    await h.fork('th-1', '/w')
    expect(sent.filter((m) => m.method === 'thread/fork').at(-1)?.params).not.toHaveProperty(
      'lastTurnId',
    )
    await expect(h.fork('th-1', '/w', 7)).rejects.toThrow('only 2 turns')
  })

  it('closes the throwaway server and reports a server that does not answer', async () => {
    const { transport } = scriptedTransport({ initialize: () => ({}) })
    const run = createWithAppServer(() => transport, log, 30)
    await run(async () => 1)
    expect(transport.close).toHaveBeenCalled()

    const silent: Transport = {
      send: () => {},
      onLine: () => {},
      onClose: () => {},
      close: vi.fn(),
    }
    await expect(createWithAppServer(() => silent, log, 30)(async () => 1)).rejects.toThrow(
      'in time',
    )
    expect(silent.close).toHaveBeenCalled()
  })

  it('is exposed by the adapter', async () => {
    const server = scriptedTransport({
      initialize: () => ({}),
      'thread/list': () => ({ data: [] }),
      'skills/list': () => ({
        data: [{ cwd: '/w', skills: [{ name: 'pdf', description: 'PDFs', enabled: true }] }],
      }),
    })
    const adapter = createCodexAdapter({
      executablePath: process.execPath,
      createTransport: () => server.transport,
      log,
    })
    expect(adapter.capabilities('codex')).toMatchObject({
      steer: true,
      fork: true,
      history: true,
      mcp: true,
    })
    expect(await adapter.listHistory?.('codex', '/w')).toEqual([])
    const commands = (await adapter.listCommands?.('codex', '/w')) ?? []
    expect(commands.slice(0, 2).map((c) => c.name)).toEqual(['compact', 'review'])
    expect(commands.filter((c) => c.kind === 'skill')).toEqual([
      { name: 'pdf', description: 'PDFs', kind: 'skill' },
    ])
  })

  it('turns skills into commands, hiding disabled ones', () => {
    expect(
      skillsToCommands([
        { name: 'b', description: 'long', shortDescription: 'short', enabled: true },
        { name: 'a', description: 'only long' },
        { name: 'c', enabled: false },
      ]),
    ).toEqual([
      { name: 'a', description: 'only long', kind: 'skill' },
      { name: 'b', description: 'short', kind: 'skill' },
    ])
  })
})

describe('Codex MCP through its CLI', () => {
  it('parses the JSON listing', () => {
    const json = JSON.stringify([
      {
        name: 'files',
        enabled: true,
        disabled_reason: null,
        transport: { type: 'stdio', command: 'npx', args: ['-y', 'srv'] },
        auth_status: 'unsupported',
      },
      {
        name: 'remote',
        enabled: true,
        transport: { type: 'streamable_http', url: 'https://x.example/mcp' },
        auth_status: 'not_logged_in',
      },
      {
        name: 'off',
        enabled: false,
        disabled_reason: 'requirements',
        transport: { type: 'stdio', command: 'x' },
      },
    ])
    expect(parseMcpJson(json)).toEqual([
      { name: 'files', transport: 'stdio', target: 'npx -y srv', status: 'unknown' },
      { name: 'remote', transport: 'http', target: 'https://x.example/mcp', status: 'needs-auth' },
      { name: 'off', transport: 'stdio', target: 'x', status: 'disabled', error: 'requirements' },
    ])
    expect(() => parseMcpJson('nope')).toThrow('did not return')
    expect(parseMcpJson('{}')).toEqual([])
  })

  it('builds add arguments and rejects impossible combinations', () => {
    expect(
      addArgs({ name: 'fs', transport: 'stdio', command: 'npx', args: ['srv'], env: { K: 'v' } }),
    ).toEqual(['mcp', 'add', 'fs', '--env', 'K=v', '--', 'npx', 'srv'])
    expect(addArgs({ name: 'r', transport: 'http', url: 'https://x' })).toEqual([
      'mcp',
      'add',
      'r',
      '--url',
      'https://x',
    ])
    expect(() =>
      addArgs({ name: 'r', transport: 'http', url: 'https://x', env: { A: 'b' } }),
    ).toThrow('local')
    expect(() => addArgs({ name: 'r', transport: 'http' })).toThrow('URL')
  })

  it('runs the CLI and surfaces its errors', async () => {
    const run = vi.fn(async (_f: string, args: string[]) =>
      args[1] === 'remove'
        ? { code: 1, stdout: '', stderr: 'No MCP server named nope' }
        : { code: 0, stdout: args[1] === 'list' ? '[]' : '', stderr: '' },
    )
    const mcp = createCodexMcp(() => '/bin/codex', {}, run)
    expect(await mcp.list('codex')).toEqual([])
    await mcp.add('codex', { name: 'a', transport: 'stdio', command: 'x' })
    await expect(mcp.remove('codex', 'nope')).rejects.toThrow('No MCP server named nope')
    expect(run.mock.calls.map((c) => c[1])).toEqual([
      ['mcp', 'list', '--json'],
      ['mcp', 'add', 'a', '--', 'x'],
      ['mcp', 'remove', 'nope'],
    ])
    await expect(createCodexMcp(() => null, {}, run).list('codex')).rejects.toThrow('not installed')
  })
})
