import { afterAll, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { createLogger, openSupervisedTransport } from '@beddcode/shared'
import { alive, collect, scratch, until } from '../../shared/src/supervisor/testing/harness.ts'
import { AcpSession } from './session.ts'
import { ACP_HANDSHAKE } from './supervised.ts'

const log = createLogger('test', 'error')
const text = (events: SessionEvent[]) =>
  events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : [])).join('')
const input = { sessionId: 'acp-1', cwd: process.cwd() }

describe('an ACP agent under the supervisor', () => {
  const s = scratch('acp', { FAKE_ASK: '1' })
  afterAll(() => s.cleanup())

  it('ends a turn whose answer came while no host was there, and loses no output', async () => {
    const open = (host: ReturnType<typeof s.host>, reattach: boolean) =>
      openSupervisedTransport(
        host,
        input.sessionId,
        { ...s.spec, handshake: ACP_HANDSHAKE },
        { reattach, log },
      )
    const deps = (transport: Awaited<ReturnType<typeof open>>) => ({
      transport,
      log,
      label: 'Fake',
    })

    const first = new AcpSession(input, deps(await open(s.host(), false)))
    const seen1 = collect(first)
    void first.prompt({ text: 'go', attachments: [] } as never).catch(() => {})
    await until(() => seen1.some((e) => e.type === 'approval.requested'))
    const asked1 = seen1.find((e) => e.type === 'approval.requested')
    if (asked1?.type !== 'approval.requested') throw new Error('no approval')
    // The user allows it, and the host stops while the agent is still working.
    await first.respondToApproval(asked1.requestId, 'allow')
    await until(() => text(seen1).includes('part 2;'))
    const pid = s.pid()
    await first.detach()
    // The turn's end (the answer to the old host's session/prompt) happens with nobody attached.
    await new Promise((r) => setTimeout(r, 2_500))
    expect(alive(pid)).toBe(true)

    const second = new AcpSession({ ...input, resumeId: 'acp1' }, deps(await open(s.host(), true)))
    expect(second.reattached).toBe(true)
    const seen2 = collect(second)
    await until(() => seen2.some((e) => e.type === 'turn.completed'))

    expect(seen2.find((e) => e.type === 'turn.completed')).toMatchObject({ reason: 'done' })
    expect(s.starts()).toBe('x')
    const methods = s.received().map((l) => (JSON.parse(l) as { method?: string }).method)
    expect(methods.filter((m) => m === 'initialize')).toHaveLength(1)
    expect(methods.filter((m) => m === 'session/new')).toHaveLength(1)
    expect(methods.filter((m) => m === 'session/prompt')).toHaveLength(1)
    const all = text([...seen1, ...seen2])
    for (let i = 1; i <= 8; i++) expect(all).toContain(`part ${i};`)
    await second.close()
    await until(() => !alive(pid))
  }, 40_000)
})
