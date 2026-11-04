import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { applyEvents, emptyReplica } from '@beddcode/client-runtime/replica'
import { createAsyncQueue, createLogger, type Transport } from '@beddcode/shared'
import { ClaudeSession, type QueryFn } from '../../../../packages/provider-claude/src/session.ts'
import { CodexSession } from '../../../../packages/provider-codex/src/session.ts'
import { AcpSession } from '../../../../packages/provider-acp/src/session.ts'

const log = createLogger('replay', 'error')
const input = { sessionId: 's1', cwd: '/work' }
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./replay-fixtures/${name}.json`, import.meta.url), 'utf8')) as T

type Response = { result?: unknown; error?: { code: number; message: string } }

function rpcReplay(name: string, jsonrpc: boolean, malformed = false): Transport {
  const responses = fixture<Record<string, Response>>(name)
  let onLine: (line: string) => void = () => {}
  let onClose: () => void = () => {}
  return {
    send(line) {
      const request = JSON.parse(line) as { id?: number; method?: string }
      if (request.id === undefined || !request.method) return
      const response = responses[request.method]
      if (!response) throw new Error(`Unexpected request: ${request.method}`)
      queueMicrotask(() => {
        if (malformed && request.method === 'turn/start') onLine('{malformed')
        onLine(
          JSON.stringify({ ...(jsonrpc ? { jsonrpc: '2.0' } : {}), id: request.id, ...response }),
        )
      })
    },
    onLine: (handler) => (onLine = handler),
    onClose: (handler) => (onClose = handler),
    close: () => onClose(),
  }
}

function claudeReplay(): QueryFn {
  return (({ prompt }: Parameters<QueryFn>[0]) => {
    const messages = createAsyncQueue<unknown>()
    void (async () => {
      for await (const _ of prompt as AsyncIterable<unknown>) {
        for (const message of fixture<unknown[]>('claude-error')) messages.push(message)
      }
      messages.close()
    })()
    return Object.assign(messages, { interrupt: async () => {} })
  }) as unknown as QueryFn
}

async function replay(provider: 'claude' | 'codex' | 'acp') {
  const session =
    provider === 'claude'
      ? new ClaudeSession(input, { queryFn: claudeReplay(), log })
      : provider === 'codex'
        ? new CodexSession(input, {
            transport: rpcReplay('codex-error', false, true),
            log,
            promptsDir: '/nonexistent-prompts',
          })
        : new AcpSession(input, {
            transport: rpcReplay('acp-cancelled', true),
            log,
            label: 'Agent',
          })
  await session.prompt({ text: 'Run the task' })
  await session.close()
  const events: SessionEvent[] = []
  for await (const event of session.events) events.push(event)
  const created: SessionEvent = {
    type: 'session.created',
    sessionId: 's1',
    at: 1,
    title: 'Replay',
    cwd: '/work',
    instanceId: 'fixture',
  }
  const stored: StoredEvent[] = [created, ...events].map((event, i) => ({ seq: i + 1, event }))
  const projection = applyEvents(emptyReplica(), stored)
  // Reconnecting from an older cursor resends the overlap as well as the remaining events.
  const reconnect = applyEvents(applyEvents(emptyReplica(), stored.slice(0, 2)), stored.slice(1))
  expect(reconnect).toEqual(projection)
  return { events, view: projection.sessions.s1! }
}

describe('provider boundary replay', () => {
  it.each(['claude', 'codex'] as const)(
    '%s shows a failed turn after the provider error',
    async (provider) => {
      const { events, view } = await replay(provider)
      const types = events.map((event) => event.type)
      expect(types).toEqual(expect.arrayContaining(['turn.started', 'error', 'turn.completed']))
      expect(types.indexOf('turn.started')).toBeLessThan(types.indexOf('error'))
      expect(types.indexOf('error')).toBeLessThan(types.indexOf('turn.completed'))
      expect(view).toMatchObject({ status: 'failed', lastTurnReason: 'error', completedTurns: 1 })
      expect(view.items).toContainEqual(
        expect.objectContaining({ kind: 'error', message: 'Provider unavailable' }),
      )
    },
  )

  it('shows an ACP cancellation as a finished idle turn', async () => {
    const { events, view } = await replay('acp')
    expect(
      events.filter((event) => event.type.startsWith('turn.')).map((event) => event.type),
    ).toEqual(['turn.started', 'turn.completed'])
    expect(view).toMatchObject({ status: 'idle', lastTurnReason: 'cancelled', completedTurns: 1 })
    expect(view.items.filter((item) => item.kind === 'error')).toEqual([])
  })
})
