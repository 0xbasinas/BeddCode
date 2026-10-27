import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Host } from '../shared/hostClient.ts'
import { desktopEnv, launchDesktop, root, type DesktopEnv } from './launch.ts'

// How a real agent behaves while a command runs for a while and prints nothing: does the host see
// any events at all in between? The idle limit for helpers (agentTools' idle_minutes) rests on it.
const SECONDS = Number(process.env.DESKTOP_IDLE_SECONDS) || 75
const agents = [
  { name: 'claude', id: 'claude', mode: 'default' },
  { name: 'codex', id: 'codex', mode: 'auto' },
  { name: 'grok', id: 'acp:grok', mode: 'ask' },
].filter((a) => (process.env.DESKTOP_PROVIDERS ?? 'claude,codex,grok').split(',').includes(a.name))

let env: DesktopEnv
let app: ElectronApplication
let host: Host
let approving = true
const report: Record<string, any> = { seconds: SECONDS, agents: {} }

beforeAll(async () => {
  env = await desktopEnv(true)
  const launched = await launchDesktop(env, true)
  app = launched.app
  await launched.page
    .getByRole('heading', { name: 'Welcome to BeddCode' })
    .waitFor({ timeout: 90_000 })
  await launched.page.getByRole('button', { name: 'Skip setup' }).click()
  host = new Host(`ws://127.0.0.1:${env.port}/ws`)
  await host.connect()
  // Allow the one harmless command each agent is asked to run.
  const answered = new Set<string>()
  void (async () => {
    while (approving) {
      for (const { event } of host.events) {
        if (event.type !== 'approval.requested') continue
        const key = `${event.sessionId}:${event.requestId}`
        if (answered.has(key)) continue
        answered.add(key)
        const allow = event.options.find((o: any) => o.kind === 'allow')
        if (allow)
          await host
            .rpc('sessions.approve', {
              sessionId: event.sessionId,
              requestId: event.requestId,
              optionId: allow.id,
            })
            .catch(() => {})
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  })()
})

afterAll(async () => {
  approving = false
  host?.close()
  await app?.close().catch(() => {})
  const dir = path.join(root, '.e2e', 'desktop-stats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `idle-${Date.now()}.json`), JSON.stringify(report, null, 2))
  for (const folder of [env?.home, env?.userData]) {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
})

describe.each(agents)('$name during a silent command', (agent) => {
  test('reports how long the host hears nothing', async () => {
    const { sessionId } = await host.rpc('sessions.create', {
      instanceId: agent.id,
      projectless: true,
      permissionMode: agent.mode,
      title: `Idle ${agent.name}`,
    })
    await host.wait(
      () =>
        host.events.some(
          ({ event }) => event.type === 'session.created' && event.sessionId === sessionId,
        ),
      15_000,
    )
    const from = host.events.length
    await host.rpc('sessions.prompt', {
      sessionId,
      text: `Run one shell command that waits ${SECONDS} seconds and prints nothing while it waits (for example "sleep ${SECONDS}", or in PowerShell "Start-Sleep -Seconds ${SECONDS}"). When it finishes, reply with only the word SLEPT.`,
    })
    const mine = () => host.events.slice(from).filter(({ event }) => event.sessionId === sessionId)
    await host.wait(() => mine().some(({ event }) => event.type === 'turn.completed'), 300_000)

    const events = mine().map(({ event }) => event)
    const received = mine().map(({ seq }) => seq)
    // The time between one event and the next, by the host's own clock for each.
    const gaps = events.slice(1).map((e, i) => e.at - events[i]!.at)
    const longest = Math.max(0, ...gaps)
    const at = gaps.indexOf(longest)
    report.agents[agent.name] = {
      events: events.length,
      longestSilenceMs: longest,
      betweenTypes: at >= 0 ? [events[at]!.type, events[at + 1]!.type] : [],
      types: [...new Set(events.map((e) => e.type))],
      end: events.findLast((e) => e.type === 'turn.completed')?.reason,
      replied: events
        .filter((e) => e.type === 'message.delta' && e.role === 'assistant')
        .map((e) => e.text)
        .join('')
        .includes('SLEPT'),
      firstSeq: received[0],
    }
    expect(report.agents[agent.name].end).toBe('done')
    expect(report.agents[agent.name].replied).toBe(true)
  })
})
