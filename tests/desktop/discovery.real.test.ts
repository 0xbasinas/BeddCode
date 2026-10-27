import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ElectronApplication } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Host } from '../shared/hostClient.ts'
import { desktopEnv, launchDesktop, root, type DesktopEnv } from './launch.ts'

// Can a real agent find and use the orchestration tools on its own? The prompt is plain English:
// it never names a tool, the MCP server or its arguments. This measures, it does not demand
// success, so the numbers are written to .e2e/desktop-stats and only the basics are asserted.
const agents = {
  claude: { id: 'claude', label: 'Claude', mode: 'default' },
  codex: { id: 'codex', label: 'Codex', mode: 'auto' },
  grok: { id: 'acp:grok', label: 'Grok', mode: 'ask' },
} as const
type Name = keyof typeof agents
const parents = (process.env.DESKTOP_PARENTS ?? 'claude,codex,grok')
  .split(',')
  .filter((n): n is Name => n in agents)

let env: DesktopEnv
let app: ElectronApplication
let host: Host
let approving = true
const report: Record<string, any> = { startedAt: new Date().toISOString(), runs: {} }

const created = (id: string) =>
  host.events.find(({ event }) => event.type === 'session.created' && event.sessionId === id)?.event
const of = (id: string) => host.events.filter(({ event }) => event.sessionId === id)
const text = (id: string) =>
  of(id)
    .filter(({ event }) => event.type === 'message.delta' && event.role === 'assistant')
    .map(({ event }) => event.text)
    .join('')
const ended = (id: string) => of(id).findLast(({ event }) => event.type === 'turn.completed')?.event
const childrenOf = (id: string) =>
  host.events
    .filter(({ event }) => event.type === 'session.created' && event.parent?.sessionId === id)
    .map(({ event }) => event.sessionId as string)

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
  // Answer every approval: the point is whether the agent finds the tools, not who may run them.
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
      await new Promise((r) => setTimeout(r, 300))
    }
  })()
})

afterAll(async () => {
  approving = false
  host?.close()
  await app?.close().catch(() => {})
  const dir = path.join(root, '.e2e', 'desktop-stats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `discovery-${Date.now()}.json`), JSON.stringify(report, null, 2))
  for (const folder of [env?.home, env?.userData]) {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
})

describe.each(parents)('%s given a plain request', (parent) => {
  test('finds the agent tools by itself', async () => {
    const [a, b] = (Object.keys(agents) as Name[]).filter((n) => n !== parent)
    const marker = `DISC-${crypto.randomUUID().slice(0, 6)}`
    const repo = mkdtempSync(path.join(os.tmpdir(), 'beddcode-disc-'))
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args], {
        cwd: repo,
      })
    git('init', '-q')
    writeFileSync(path.join(repo, 'README.md'), '# demo\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')

    const { sessionId } = await host.rpc('sessions.create', {
      instanceId: agents[parent].id,
      cwd: repo,
      title: `Plain ${parent}`,
      agentTools: true,
      permissionMode: agents[parent].mode,
    })
    await host.wait(() => created(sessionId) !== undefined, 15_000)
    await host.rpc('sessions.prompt', {
      sessionId,
      text: [
        `I want two other coding agents to help, ${agents[a].label} and ${agents[b].label}.`,
        `Have ${agents[a].label} create a file called ${marker}.md that says hello.`,
        `Have ${agents[b].label} look at what ${agents[a].label} made and tell you if it is fine.`,
        `Do not do the work yourself. When they are done, tell me in one line what each of them said, starting with ${marker}.`,
      ].join(' '),
    })

    try {
      await host.wait(() => ended(sessionId) !== undefined, 600_000)
    } catch {
      // Reported below as not finishing.
    }
    const kids = childrenOf(sessionId)
    const tools = of(sessionId)
      .filter(({ event }) => event.type === 'tool.started')
      .map(({ event }) => String(event.title ?? event.name ?? ''))
    const row = {
      finished: ended(sessionId)?.reason ?? 'no',
      helpers: kids.map((k) => ({
        agent: created(k)!.instanceId,
        worktree: Boolean(created(k)!.worktree),
        mode: created(k)!.permissionMode,
        end: ended(k)?.reason ?? 'none',
        reported: of(k).find(({ event }) => event.type === 'session.result')?.event.status,
      })),
      usedAgents: [...new Set(kids.map((k) => created(k)!.instanceId))],
      waited: tools.some((t) => /wait_for/.test(t)),
      toolCalls: tools,
      answer: text(sessionId).trim().slice(-400),
    }
    report.runs[parent] = row
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 2 })
    } catch {
      // Windows may still hold the folder; the temp cleaner gets it.
    }
    // Only the basics: it ended, and it started somebody. Anything beyond is in the report.
    expect(row.finished).not.toBe('no')
    expect(kids.length, JSON.stringify(row, null, 2)).toBeGreaterThan(0)
  })
})
