import { describe, expect, it } from 'vitest'
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '@beddcode/contracts'
import { createLogger, createAsyncQueue } from '@beddcode/shared'
import { createClaudeAdapter } from './adapter.ts'
import { ClaudeSession, type QueryFn } from './session.ts'

const log = createLogger('test', 'error')

interface Harness {
  queryFn: QueryFn
  lastOptions(): Options
  decisions: PermissionResult[]
  interrupts: number
}

/**
 * A scripted stand-in for the Agent SDK: for each user prompt it runs a Bash tool that needs
 * permission, then ends the turn. Mirrors the real message order (assistant tool_use, permission
 * callback, tool_result, result).
 */
function fakeSdk(): Harness {
  let options: Options = {}
  const h: Harness = {
    decisions: [],
    interrupts: 0,
    lastOptions: () => options,
    queryFn: ({ prompt, options: o }) => {
      options = o ?? {}
      const out = createAsyncQueue<SDKMessage>()
      void (async () => {
        out.push({
          type: 'system',
          subtype: 'init',
          session_id: 'claude-sess-1',
        } as unknown as SDKMessage)
        for await (const _user of prompt as AsyncIterable<SDKUserMessage>) {
          out.push({
            type: 'assistant',
            parent_tool_use_id: null,
            message: {
              id: 'm1',
              content: [
                { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'pnpm test' } },
              ],
            },
          } as unknown as SDKMessage)
          const decision = (await (options.canUseTool as CanUseTool)(
            'Bash',
            { command: 'pnpm test' },
            {
              signal: new AbortController().signal,
              toolUseID: 'tu1',
              requestId: 'sdk-req-1',
              suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
            },
          )) as PermissionResult
          h.decisions.push(decision)
          const ok = decision.behavior === 'allow'
          out.push({
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu1',
                  is_error: !ok,
                  content: ok ? 'passed' : 'denied',
                },
              ],
            },
          } as unknown as SDKMessage)
          out.push({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'done',
          } as unknown as SDKMessage)
        }
        out.close()
      })()
      const closeQueue = out.close.bind(out)
      const q = out as unknown as Query
      return Object.assign(q, {
        interrupt: async () => {
          h.interrupts++
          return undefined
        },
        setPermissionMode: async () => {},
        close: closeQueue,
      })
    },
  }
  return h
}

async function collectUntil(session: ClaudeSession, stop: (e: SessionEvent) => boolean) {
  const seen: SessionEvent[] = []
  for await (const e of session.events) {
    seen.push(e)
    if (stop(e)) break
  }
  return seen
}

const start = (
  h: Harness,
  extra: Partial<Parameters<typeof ClaudeSession.prototype.prompt>[0]> = {},
) => {
  void extra
  return new ClaudeSession(
    { sessionId: 's1', cwd: '/work', permissionMode: 'default' },
    { queryFn: h.queryFn, log },
  )
}

describe('ClaudeSession', () => {
  it('uses an ephemeral tool-free configuration for metadata generation', async () => {
    const h = fakeSdk()
    const session = new ClaudeSession(
      { sessionId: 'metadata', cwd: '/scratch', textOnly: true },
      { queryFn: h.queryFn, log },
    )
    expect(h.lastOptions()).toMatchObject({
      tools: [],
      mcpServers: {},
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      thinking: { type: 'disabled' },
    })
    await session.close()
  })
  it('relays a permission request and returns the allow decision to Claude', async () => {
    const h = fakeSdk()
    const session = start(h)
    const turn = session.prompt({ text: 'run the tests' })

    const request = await (async () => {
      for await (const e of session.events) if (e.type === 'approval.requested') return e
      throw new Error('no approval')
    })()
    expect(request.options.map((o) => o.id)).toEqual(['allow', 'deny', 'allow-session'])
    expect(request.detail).toBe('pnpm test')

    await session.respondToApproval(request.requestId, 'allow')
    await turn
    expect(h.decisions[0]).toMatchObject({ behavior: 'allow' })
    await session.close()
  })

  it('"always for this session" forwards Claude\'s own permission suggestions', async () => {
    const h = fakeSdk()
    const session = start(h)
    const turn = session.prompt({ text: 'go' })
    for await (const e of session.events) {
      if (e.type === 'approval.requested') {
        await session.respondToApproval(e.requestId, 'allow-session')
        break
      }
    }
    await turn
    expect(h.decisions[0]).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits' }],
    })
    await session.close()
  })

  it('returns a deny decision and completes the turn', async () => {
    const h = fakeSdk()
    const session = start(h)
    const turn = session.prompt({ text: 'go' })
    const events: SessionEvent[] = []
    for await (const e of session.events) {
      events.push(e)
      if (e.type === 'approval.requested') await session.respondToApproval(e.requestId, 'deny')
      if (e.type === 'turn.completed') break
    }
    await turn
    expect(h.decisions[0]).toMatchObject({ behavior: 'deny' })
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: false })
    expect(events.map((e) => e.type)).toContain('approval.resolved')
    await session.close()
  })

  it('passes cwd, mode, resume id and the user settings sources to the SDK', async () => {
    const h = fakeSdk()
    const session = new ClaudeSession(
      {
        sessionId: 's1',
        cwd: '/work',
        permissionMode: 'plan',
        resumeId: 'prev',
        model: 'sonnet',
        additionalDirectories: ['/data/attachments'],
      },
      { queryFn: h.queryFn, log, executablePath: '/bin/claude' },
    )
    expect(h.lastOptions()).toMatchObject({
      cwd: '/work',
      permissionMode: 'plan',
      resume: 'prev',
      model: 'sonnet',
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      additionalDirectories: ['/data/attachments'],
      pathToClaudeCodeExecutable: '/bin/claude',
    })
    await session.close()
  })

  it('interrupt cancels pending approvals and tells Claude to stop', async () => {
    const h = fakeSdk()
    const session = start(h)
    void session.prompt({ text: 'go' }).catch(() => {})
    for await (const e of session.events) if (e.type === 'approval.requested') break
    await session.interrupt()
    expect(h.interrupts).toBe(1)
    expect(h.decisions[0]).toMatchObject({ behavior: 'deny' })
    await session.close()
  })

  it('records the provider session id for resume', async () => {
    const h = fakeSdk()
    const session = start(h)
    const seen = await collectUntil(session, (e) => e.type === 'session.provider-session')
    expect(seen.at(-1)).toMatchObject({ providerSessionId: 'claude-sess-1' })
    await session.close()
  })
})

describe('createClaudeAdapter', () => {
  it('reports not-installed when the binary cannot be found', async () => {
    const adapter = createClaudeAdapter({ executablePath: '/definitely/not/here/claude' })
    const [instance] = await adapter.detect()
    expect(instance).toMatchObject({ id: 'claude', kind: 'claude', status: 'not-installed' })
    expect(instance?.capabilities.permissionModes.map((m) => m.id)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
    ])
  })
})
