import { afterAll, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { createLogger } from '@beddcode/shared'
import {
  alive,
  collect,
  fakeAgent,
  scratch,
  until,
} from '../../shared/src/supervisor/testing/harness.ts'
import { PiSession } from './adapter.ts'

const log = createLogger('test', 'error')
const text = (events: SessionEvent[]) =>
  events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : [])).join('')

describe('Pi under the supervisor', () => {
  const s = scratch('pi')
  afterAll(() => s.cleanup())
  // The fake takes the place of `pi` behind node: its own arguments follow the script.
  const deps = (host: ReturnType<typeof s.host>, attached?: unknown) => ({
    exe: process.execPath,
    exeArgs: [fakeAgent],
    log,
    models: [],
    supervisor: host,
    attached: attached as never,
  })
  const input = { sessionId: 'pi-1', cwd: s.root }

  it('survives a host restart mid-turn and carries the turn on without a new prompt', async () => {
    Object.assign(process.env, { FAKE_FLAVOR: 'pi', FAKE_STATE: s.env.FAKE_STATE })
    const first = new PiSession(input, deps(s.host()))
    const seen1 = collect(first)
    await first.prompt({ text: 'go', attachments: [] } as never)
    await until(() => text(seen1).includes('part 2;'))
    const pid = s.pid()
    await first.detach()
    expect(alive(pid)).toBe(true)

    const host = s.host()
    const attached = await host.attach(input.sessionId)
    expect(attached).toBeDefined()
    const second = new PiSession({ ...input, resumeId: '/tmp/fake-pi.jsonl' }, deps(host, attached))
    expect(second.reattached).toBe(true)
    const seen2 = collect(second)
    await until(() => seen2.some((e) => e.type === 'turn.completed'))

    expect(s.starts()).toBe('x')
    const sent = s.received().map((l) => (JSON.parse(l) as { type?: string }).type)
    expect(sent.filter((t) => t === 'prompt')).toHaveLength(1)
    expect(sent).not.toContain('switch_session') // already open in the running Pi
    const all = text([...seen1, ...seen2])
    for (let i = 1; i <= 8; i++) expect(all).toContain(`part ${i};`)
    await second.close()
    await until(() => !alive(pid))
  }, 40_000)
})
