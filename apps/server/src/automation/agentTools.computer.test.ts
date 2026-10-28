import { describe, expect, it } from 'vitest'
import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { ComputerTools } from '../computer/computerTools.ts'
import type { DesktopDriver } from '../computer/driver.ts'
import { AgentTools, type AgentToolsHost } from './agentTools.ts'

/** A host that only knows how a session was created: enough for the tool lists and routing. */
function tools(flags: Partial<Extract<SessionEvent, { type: 'session.created' }>>) {
  const created: StoredEvent = {
    seq: 1,
    event: {
      type: 'session.created',
      sessionId: 's1',
      at: 0,
      title: 't',
      cwd: '/p',
      instanceId: 'claude',
      ...flags,
    },
  }
  const host = { readSession: () => [created] } as unknown as AgentToolsHost
  let driverLoads = 0
  const desktop = {
    name: 'fake',
    ready: async () => ({ ok: true }),
    windows: async () => ({
      ok: true,
      windows: [{ id: 1, pid: 1, app: 'Mail', title: 'Inbox', onScreen: true }],
    }),
  } as unknown as DesktopDriver
  const computer = new ComputerTools(
    async () => {
      driverLoads++
      return { ok: true, driver: desktop }
    },
    {
      currentMode: () => 'default',
      modeLevel: () => 1,
      describe: async () => ({ agent: 'Claude' }),
      askUser: async () => true,
    },
    '/tmp/computer-images',
  )
  const agent = new AgentTools(
    host,
    { file: 'bridge.mjs', url: () => 'http://x' },
    undefined,
    undefined,
    computer,
  )
  return { agent, loads: () => driverLoads }
}

const names = (r: unknown) => (r as { tools: { name: string }[] }).tools.map((t) => t.name)

describe('computer tools in the agent tools server', () => {
  it('lists computer_* tools only to sessions created with them', async () => {
    const withTools = tools({ computerTools: true })
    expect(names(await withTools.agent.handle('s1', 'tools/list', {}))).toEqual(
      expect.arrayContaining(['computer_windows', 'computer_snapshot', 'computer_type']),
    )
    const without = tools({ browserTools: true })
    expect(
      names(await without.agent.handle('s1', 'tools/list', {})).some((n) =>
        n.startsWith('computer_'),
      ),
    ).toBe(false)
  })

  it('does not hand the agent-starting tools to a session that only has computer tools', async () => {
    const t = tools({ computerTools: true })
    const list = names(await t.agent.handle('s1', 'tools/list', {}))
    expect(list).not.toContain('start_session')
  })

  it('adds the computer instructions, and refuses calls from other sessions', async () => {
    const t = tools({ computerTools: true })
    expect(await t.agent.handle('s1', 'instructions', {})).toMatch(/computer tools operate windows/)
    const other = tools({ browserTools: true })
    const r = (await other.agent.handle('s1', 'tools/call', {
      name: 'computer_windows',
      arguments: {},
    })) as { isError?: boolean; content: { text: string }[] }
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/may not operate the computer/)
    expect(other.loads()).toBe(0)
  })

  it('runs a computer tool for a session that has them', async () => {
    const t = tools({ computerTools: true })
    const r = (await t.agent.handle('s1', 'tools/call', {
      name: 'computer_windows',
      arguments: {},
    })) as { isError?: boolean; content: { text: string }[] }
    expect(r.isError).toBeUndefined()
    expect(r.content[0]!.text).toContain('1\tMail\t"Inbox"')
  })
})
