import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Host } from '../shared/hostClient.ts'
import { desktopEnv, launchDesktop, root, type DesktopEnv } from './launch.ts'

// One real agent starts two others through BeddCode's agent tools, inside the real desktop app.
// Real CLIs use provider quota, so the prompts are tiny. Pick parents with DESKTOP_PARENTS.
const agents = {
  claude: { id: 'claude', label: 'Claude' },
  codex: { id: 'codex', label: 'Codex' },
  grok: { id: 'acp:grok', label: 'Grok' },
} as const
type Name = keyof typeof agents
const parents = (process.env.DESKTOP_PARENTS ?? 'claude,codex,grok')
  .split(',')
  .filter((n): n is Name => n in agents)

let env: DesktopEnv
let app: ElectronApplication
let page: Page
let host: Host
const report: Record<string, any> = { startedAt: new Date().toISOString(), runs: {} }
const approver = new Set<string>()
let approving = true

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

/** Answers the parent's own tool approvals so it can call BeddCode's tools; never a child's. */
async function approveParents() {
  const answered = new Set<string>()
  while (approving) {
    for (const { event } of host.events) {
      if (event.type !== 'approval.requested' || !approver.has(event.sessionId)) continue
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
}

async function startParent(name: Name, prompt: string, mode?: string) {
  const { sessionId } = await host.rpc('sessions.create', {
    instanceId: agents[name].id,
    projectless: true,
    title: `Orchestrator ${name}`,
    agentTools: true,
    ...(mode ? { permissionMode: mode } : {}),
  })
  approver.add(sessionId)
  await host.wait(() => created(sessionId) !== undefined, 15_000)
  await host.rpc('sessions.prompt', { sessionId, text: prompt })
  return sessionId as string
}

beforeAll(async () => {
  env = await desktopEnv(true)
  const launched = await launchDesktop(env, true)
  app = launched.app
  page = launched.page
  await page.getByRole('heading', { name: 'Welcome to BeddCode' }).waitFor({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Skip setup' }).click()
  host = new Host(`ws://127.0.0.1:${env.port}/ws`)
  await host.connect()
  void approveParents()
})

afterAll(async () => {
  approving = false
  host?.close()
  await app?.close().catch(() => {})
  const dir = path.join(root, '.e2e', 'desktop-stats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `orchestration-${Date.now()}.json`), JSON.stringify(report, null, 2))
  for (const folder of [env?.home, env?.userData]) {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
})

describe.each(parents)('%s as the orchestrator', (parent) => {
  test('starts the other two agents, waits for both, and repeats a start without a duplicate', async () => {
    const [a, b] = (Object.keys(agents) as Name[]).filter((n) => n !== parent)
    const marker = `ORCH-${crypto.randomUUID().slice(0, 8)}`
    const childPrompt = (n: Name) =>
      `First call the report_result tool once with status "done" and the summary "${marker}-${n.toUpperCase()}". Then reply with exactly the text ${marker}-${n.toUpperCase()} and nothing else. Use no other tool.`
    const mode = parent === 'claude' ? 'default' : parent === 'codex' ? 'read-only' : 'ask'
    const id = await startParent(
      parent,
      [
        'This is an orchestration test. Use only the beddcode MCP tools (start_session, wait_for). Do not use shell, file or web tools.',
        `1. Call start_session with agent "${agents[a].id}", request_id "${marker}-${a}", title "Helper ${a}", and prompt: ${childPrompt(a)}`,
        `2. Call start_session with agent "${agents[b].id}", request_id "${marker}-${b}", title "Helper ${b}", and prompt: ${childPrompt(b)}`,
        `3. Call start_session a second time with exactly the arguments of step 1 (same request_id). Do not call it a third time. Note whether the answer says already_started.`,
        '4. Call wait_for for each session_id (repeat while done is false), and note each result.status if present.',
        `5. End with one line: ${marker} ${a}=<reply> ${b}=<reply> ${a}_result=<status or none> ${b}_result=<status or none> already_started=<true or false>`,
      ].join('\n'),
      mode,
    )

    await host.wait(() => ended(id) !== undefined, 480_000)
    const kids = childrenOf(id)
    const rows = kids.map((k) => ({
      agent: created(k)!.instanceId as string,
      requestId: created(k)!.parent.requestId as string | undefined,
      depth: created(k)!.parent.depth as number,
      mode: created(k)!.permissionMode as string | undefined,
      turn: ended(k)?.reason ?? 'none',
      reply: text(k).trim(),
      reported: of(k).find(({ event }) => event.type === 'session.result')?.event,
      trail: of(k)
        .filter(({ event }) => /^(tool\.|error|approval\.requested)/.test(event.type))
        .map(({ event }) =>
          `${event.type} ${event.title ?? ''} ${event.message ?? ''} ${event.status ?? ''}`.trim(),
        ),
    }))
    report.runs[parent] = {
      parentEnd: ended(id)?.reason,
      parentFinalLine: text(id).trim().split('\n').at(-1),
      toolErrors: of(id).filter(({ event }) => event.type === 'error').length,
      children: rows,
    }

    // The window shows the orchestrator and its helpers.
    await page.goto(`http://127.0.0.1:${env.port}/#/session/${id}`)
    await page.locator('main.thread').waitFor({ timeout: 30_000 })
    await page.waitForTimeout(1500)
    const dir = path.join(root, '.e2e', 'desktop-stats')
    mkdirSync(dir, { recursive: true })
    await page.screenshot({ path: path.join(dir, `orchestration-${parent}.png`) })
    const body = await page.innerText('body')
    report.runs[parent].window = {
      showsOrchestrator: body.includes(`Orchestrator ${parent}`),
      showsHelpers: [a, b].every((n) => body.includes(`Helper ${n}`)),
    }

    expect(ended(id)?.reason).toBe('done')
    // Exactly two helpers: the repeated start was recognised, not run twice.
    expect(kids).toHaveLength(2)
    expect(rows.map((r) => r.agent).sort()).toEqual([agents[a].id, agents[b].id].sort())
    expect(rows.map((r) => r.requestId).sort()).toEqual([`${marker}-${a}`, `${marker}-${b}`].sort())
    expect(rows.every((r) => r.depth === 1)).toBe(true)
    expect(rows.every((r) => r.turn === 'done')).toBe(true)
    for (const n of [a, b]) {
      const row = rows.find((r) => r.agent === agents[n].id)!
      expect(row.reply, `${n} replied`).toContain(`${marker}-${n.toUpperCase()}`)
    }
    // Helpers are asked to call report_result, but a model may skip it; at least one must have, and
    // whatever was reported is stored in the log as done.
    const reported = rows.filter((r) => r.reported)
    report.runs[parent].reportedCount = reported.length
    expect(reported.length).toBeGreaterThan(0)
    expect(reported.every((r) => r.reported.status === 'done')).toBe(true)
    expect(text(id)).toContain(marker)
    expect(text(id).toLowerCase()).toContain('already_started=true')
  })
})

describe('stopping an orchestrator', () => {
  test('leaves its helper working, and takes it along only when asked', async () => {
    const marker = `STOP-${crypto.randomUUID().slice(0, 8)}`
    const id = await startParent(
      'claude',
      [
        'This is an orchestration test. Use only the beddcode MCP tools.',
        `Call start_session with agent "claude", mode "default", title "Blocked helper", and prompt: Create a new file named ${marker}.txt in the current folder containing the single word hello, then say done.`,
        'Then call wait_for on it once with timeout_seconds 90, and reply with the single word WAITING.',
      ].join('\n'),
      'default',
    )
    await host.wait(() => ended(id) !== undefined, 300_000)
    const [child] = childrenOf(id)
    expect(child, 'the orchestrator started a helper').toBeDefined()

    // The helper wants to run a command and waits for an answer nobody gives.
    const asks = () => of(child!).filter(({ event }) => event.type === 'approval.requested')
    await host
      .wait(() => asks().length > 0, 120_000)
      .catch(() => {
        const trail = of(child!).map(
          ({ event }) => `${event.type} ${event.title ?? event.reason ?? ''}`,
        )
        throw new Error(`the helper never asked: ${trail.join(' | ')} :: ${text(child!)}`)
      })
    expect(ended(child!)).toBeUndefined()

    // Stopping the orchestrator's turn alone changes its direction; the helper keeps its question.
    await host.rpc('sessions.interrupt', { sessionId: id })
    await new Promise((r) => setTimeout(r, 4_000))
    expect(ended(child!), 'the helper must not be cancelled by a plain stop').toBeUndefined()

    // Asked to, the helper stops too.
    await host.rpc('sessions.interrupt', { sessionId: id, includeChildren: true })
    await host.wait(() => ended(child!) !== undefined, 30_000)
    expect(ended(child!)?.reason).toBe('cancelled')
    report.stop = { helperEnd: ended(child!)?.reason, asked: asks().length }
  })
})
