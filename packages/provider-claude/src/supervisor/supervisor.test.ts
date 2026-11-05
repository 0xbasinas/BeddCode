import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { createLogger } from '@beddcode/shared'
import { createClaudeAdapter } from '../adapter.ts'
import { SupervisorClient } from './client.ts'

const log = createLogger('test', 'error')
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fakeClaude.mjs')
const root = mkdtempSync(path.join(tmpdir(), 'bc-sup-'))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const collect = (session: { events: AsyncIterable<SessionEvent> }) => {
  const seen: SessionEvent[] = []
  void (async () => {
    for await (const e of session.events) seen.push(e)
  })()
  return seen
}
const text = (events: SessionEvent[]) =>
  events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : [])).join('')

describe('agent supervisor', () => {
  const sup = path.join(root, 'supervisor')
  afterAll(async () => {
    // Ends the daemon (it leaves on its own when idle) and anything it still holds.
    for (const a of await new SupervisorClient(sup).list()) if (alive(a.pid)) process.kill(a.pid)
    await new Promise((r) => setTimeout(r, 300))
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps the agent running through a host restart and loses none of its output', async () => {
    const state = path.join(root, 'state')
    mkdirSync(state)
    const daemonEnv = { BEDDCODE_SUPERVISOR_IDLE_MS: '500' }
    const env = { FAKE_STATE: state, FAKE_PARTS: '8', FAKE_TICK_MS: '250' }
    const makeHost = () =>
      createClaudeAdapter({
        executablePath: fake,
        log,
        supervisor: new SupervisorClient(sup, { daemonEnv }),
        // The fake reads its settings from the environment the SDK passes down.
      })
    Object.assign(process.env, env)
    const input = { sessionId: 'sess-a', cwd: root }

    // Host 1 starts a turn and is stopped part-way through it.
    const host1 = makeHost()
    const first = await host1.startSession('claude', input)
    const seen1 = collect(first)
    void first.prompt({ text: 'go', attachments: [] } as never).catch(() => {})
    await until(() => text(seen1).includes('part 2;'))
    const agentPid = Number(readFileSync(path.join(state, 'pid'), 'utf8'))
    await first.detach!()
    expect(alive(agentPid)).toBe(true)

    // Output continues while no host is attached.
    await new Promise((r) => setTimeout(r, 600))
    expect(alive(agentPid)).toBe(true)

    // Host 2 (a new client, new adapter) takes the same agent over.
    const host2 = makeHost()
    const second = await host2.startSession('claude', { ...input, reattach: true })
    expect(second.reattached).toBe(true)
    const seen2 = collect(second)
    await until(() => seen2.some((e) => e.type === 'turn.completed'))

    expect(readFileSync(path.join(state, 'starts'), 'utf8')).toBe('x') // started once
    expect(Number(readFileSync(path.join(state, 'pid'), 'utf8'))).toBe(agentPid)
    const all = text([...seen1, ...seen2])
    for (let i = 1; i <= 8; i++) expect(all).toContain(`part ${i};`)
    // Each part exactly once: acknowledged output is not sent again.
    expect(all.match(/part 3;/g)).toHaveLength(1)

    await second.close()
    await until(() => !alive(agentPid))
  }, 40_000)

  it('starts a new agent when there is nothing to reattach to', async () => {
    const host = createClaudeAdapter({
      executablePath: fake,
      log,
      supervisor: new SupervisorClient(path.join(root, 'supervisor-empty')),
    })
    const session = await host.startSession('claude', {
      sessionId: 'none',
      cwd: root,
      reattach: true,
    })
    expect(session.reattached).toBe(false)
    await session.close()
  })
})
