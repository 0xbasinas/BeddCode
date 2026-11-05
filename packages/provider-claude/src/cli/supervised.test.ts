import { afterAll, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { createLogger } from '@beddcode/shared'
import { alive, collect, scratch, until } from '../../../shared/src/supervisor/testing/harness.ts'
import { ClaudeCliSession } from './session.ts'

const log = createLogger('test', 'error')
const text = (events: SessionEvent[]) =>
  events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : [])).join('')
const input = { sessionId: 'claude-cli-1', cwd: process.cwd(), permissionMode: 'bypassPermissions' }

describe('Claude CLI backend under the supervisor', () => {
  const s = scratch('claude')
  afterAll(() => s.cleanup())

  it('survives a host restart mid-turn and loses nothing', async () => {
    const deps = (host: ReturnType<typeof s.host>) => ({
      log,
      // The agent is the fake, started as `node fakeAgent.mjs <the CLI's arguments>`.
      executablePath: process.execPath,
      launchArgs: [s.spec.args[0]!],
      env: s.env,
      supervisor: host,
    })
    const first = new ClaudeCliSession(input, deps(s.host()))
    const seen1 = collect(first)
    void first.prompt({ text: 'go', attachments: [] } as never).catch(() => {})
    await until(() => text(seen1).includes('part 2;'))
    const pid = s.pid()
    await first.detach()
    expect(alive(pid)).toBe(true)

    // Host 2 takes the same process over: it is not started again, and the prompt is not resent.
    const hostB = s.host()
    const attached = await hostB.attach(input.sessionId)
    expect(attached).toBeDefined()
    const second = new ClaudeCliSession(input, { ...deps(hostB), attached })
    expect(second.reattached).toBe(true)
    const seen2 = collect(second)
    await until(() => seen2.some((e) => e.type === 'turn.completed'))

    expect(s.starts()).toBe('x')
    expect(s.pid()).toBe(pid)
    const sent = s.received().filter((l) => (JSON.parse(l) as { type?: string }).type === 'user')
    expect(sent).toHaveLength(1)
    const all = text([...seen1, ...seen2])
    for (let i = 1; i <= 8; i++) expect(all).toContain(`part ${i};`)
    expect(all.match(/part 4;/g)).toHaveLength(1)
    await second.close()
    await until(() => !alive(pid))
  }, 40_000)
})
