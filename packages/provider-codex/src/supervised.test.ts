import { afterAll, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { createLogger, openSupervisedTransport } from '@beddcode/shared'
import { alive, collect, scratch, until } from '../../shared/src/supervisor/testing/harness.ts'
import { CodexSession } from './session.ts'

const log = createLogger('test', 'error')
const text = (events: SessionEvent[]) =>
  events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : [])).join('')
const input = { sessionId: 'codex-1', cwd: process.cwd() }
const CODEX = {
  memo: [['initialize'], ['thread/start', 'thread/resume']],
  swallow: ['initialized'],
}

describe('Codex under the supervisor', () => {
  const s = scratch('codex', { FAKE_ASK: '1' })
  afterAll(() => s.cleanup())

  it('survives a host restart mid-turn, hands over its unanswered approval, and loses nothing', async () => {
    const open = (host: ReturnType<typeof s.host>, reattach: boolean) =>
      openSupervisedTransport(
        host,
        input.sessionId,
        { ...s.spec, handshake: CODEX },
        { reattach, log },
      )

    // Host 1: starts a turn, which asks for permission, and goes away without answering.
    const first = new CodexSession(input, { transport: await open(s.host(), false), log })
    const seen1 = collect(first)
    void first.prompt({ text: 'go', attachments: [] } as never).catch(() => {})
    await until(() => seen1.some((e) => e.type === 'approval.requested'))
    const pid = s.pid()
    await first.detach()
    expect(alive(pid)).toBe(true)

    // Host 2 takes the same process over: no second handshake reaches it, the prompt is not resent.
    const second = new CodexSession(input, { transport: await open(s.host(), true), log })
    expect(second.reattached).toBe(true)
    const seen2 = collect(second)
    await until(() => seen2.some((e) => e.type === 'approval.requested'))
    const asked = seen2.find((e) => e.type === 'approval.requested')
    if (asked?.type !== 'approval.requested') throw new Error('no approval')
    await second.respondToApproval(asked.requestId, 'allow')
    await until(() => seen2.some((e) => e.type === 'turn.completed'))

    expect(s.starts()).toBe('x')
    expect(s.pid()).toBe(pid)
    const lines = s.received().map((l) => JSON.parse(l) as { method?: string })
    expect(lines.filter((l) => l.method === 'initialize')).toHaveLength(1)
    expect(lines.filter((l) => l.method === 'turn/start')).toHaveLength(1)
    expect(lines.filter((l) => l.method?.startsWith('thread/'))).toHaveLength(1)
    const all = text([...seen1, ...seen2])
    for (let i = 1; i <= 8; i++) expect(all).toContain(`part ${i};`)
    expect(all.match(/part 4;/g)).toHaveLength(1)
    await second.close()
    await until(() => !alive(pid))
  }, 40_000)
})
