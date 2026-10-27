import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Host } from '../shared/hostClient.ts'
import { desktopEnv, launchDesktop, root, type DesktopEnv } from './launch.ts'
import { openSession, stat, summarize, takeLongTasks, type Sample } from './ui.ts'

// One long conversation per agent CLI: ten user messages and ten agent replies in a single
// session, where later turns depend on what was said and found earlier. The finished session is
// then opened and switched to in the desktop window.
const providers = [
  { name: 'claude', id: 'claude', mode: 'default' },
  { name: 'codex', id: 'codex', mode: 'read-only' },
  { name: 'grok', id: 'acp:grok', mode: 'ask' },
].filter((p) => (process.env.DESKTOP_PROVIDERS ?? 'claude,grok').split(',').includes(p.name))

type Turn = { prompt: string; expect?: string[] }
const conversation = (code: string, bug: string, final: string): Turn[] => [
  { prompt: `Remember the code word ${code}. Reply with only OK.` },
  {
    prompt:
      'Read inventory.ts in this workspace and say in one sentence what reserveStock does. Do not edit files.',
  },
  {
    prompt: 'What is the BUG identifier written in that file? Reply with just the identifier.',
    expect: [bug],
  },
  { prompt: 'Without using tools, add 17 and 25. Reply with just the number.', expect: ['42'] },
  { prompt: 'Without using tools, what code word did I ask you to remember?', expect: [code] },
  { prompt: 'In one sentence, how can the returned stock become negative?' },
  { prompt: 'List the function name and its parameters, comma separated. No tools.' },
  {
    prompt: 'Without tools, which number did you compute earlier? Reply with just the number.',
    expect: ['42'],
  },
  { prompt: 'Summarize this conversation in two sentences. No tools.' },
  {
    prompt: `${final}: state the code word and the BUG identifier, separated by a space. No tools.`,
    expect: [code, bug],
  },
]

let env: DesktopEnv
let app: ElectronApplication
let page: Page
let host: Host
const report: Record<string, any> = { startedAt: new Date().toISOString(), providers: {} }

beforeAll(async () => {
  env = await desktopEnv(true)
  const launched = await launchDesktop(env, true)
  app = launched.app
  page = launched.page
  await page.getByRole('heading', { name: 'Welcome to BeddCode' }).waitFor({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Skip setup' }).click()
  host = new Host(`ws://127.0.0.1:${env.port}/ws`)
  await host.connect()
})

afterAll(async () => {
  host?.close()
  await app?.close().catch(() => {})
  const dir = path.join(root, '.e2e', 'desktop-stats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `bigsession-${Date.now()}.json`), JSON.stringify(report, null, 2))
  for (const folder of [env?.home, env?.userData]) {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
})

async function newSession(provider: (typeof providers)[number], title: string) {
  const created = await host.rpc('sessions.create', {
    instanceId: provider.id,
    projectless: true,
    permissionMode: provider.mode,
    title,
  })
  const isCreated = ({ event }: any) =>
    event.type === 'session.created' && event.sessionId === created.sessionId
  await host.wait(() => host.events.some(isCreated), 15_000)
  return {
    id: created.sessionId as string,
    cwd: host.events.find(isCreated)!.event.cwd as string,
  }
}

describe.each(providers)('$name: a 10-turn session in the desktop app', (provider) => {
  test('holds a conversation where later turns depend on earlier ones', async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const code = `MAGENTA-${tag}`
    const bug = `BUG-${tag}`
    const final = `FINAL-${tag}`
    const { id, cwd } = await newSession(provider, `Big ${provider.name} ${tag}`)
    await host.rpc('files.create', { cwd, path: 'inventory.ts', type: 'file' })
    await host.rpc('files.write', {
      cwd,
      path: 'inventory.ts',
      content: `// ${bug}\nexport function reserveStock(stock: number, quantity: number): number {\n  if (quantity <= 0) throw new Error('quantity must be positive')\n  return stock - quantity\n}\n`,
    })

    const turns: Record<string, any>[] = []
    for (const [index, turn] of conversation(code, bug, final).entries()) {
      const from = host.events.length
      const sentAt = Date.now()
      const sent = performance.now()
      await host.rpc('sessions.prompt', { sessionId: id, text: turn.prompt })
      const mine = () => host.events.slice(from).filter(({ event }) => event.sessionId === id)
      const stopped = new Set<string>()
      const deadline = Date.now() + 150_000
      while (
        !mine().some(({ event }) => event.type === 'turn.completed') &&
        Date.now() < deadline
      ) {
        for (const { event } of mine()) {
          if (event.type === 'approval.requested' && !stopped.has(event.requestId)) {
            stopped.add(event.requestId)
            await host.rpc('sessions.interrupt', { sessionId: id })
          }
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      const events = mine().map(({ event }) => event)
      const end = events.find((e) => e.type === 'turn.completed')
      const text = events
        .filter((e) => e.type === 'message.delta' && e.role === 'assistant')
        .map((e) => e.text)
        .join('')
      const first = events.find((e) => e.type === 'message.delta' && e.role === 'assistant')
      const usage = events.filter((e) => e.type === 'session.usage')
      turns.push({
        turn: index + 1,
        reason: end?.reason ?? 'timeout',
        durationMs: end ? Math.max(0, end.at - sentAt) : Math.round(performance.now() - sent),
        firstResponseMs: first ? Math.max(0, first.at - sentAt) : null,
        toolCalls: events.filter((e) => e.type === 'tool.started').length,
        inputTokens: usage.length ? usage.reduce((sum, e) => sum + (e.inputTokens ?? 0), 0) : null,
        recalled: (turn.expect ?? []).every((needle) => text.includes(needle)),
        expected: turn.expect ?? [],
        reply: text.slice(0, 200),
      })
    }

    const durations = turns.map((t) => t.durationMs as number)
    report.providers[provider.name] = {
      ...report.providers[provider.name],
      sessionId: id,
      turns,
      totalMs: durations.reduce((a, b) => a + b, 0),
      turnMs: stat(durations),
      firstHalfMedianMs: stat(durations.slice(0, 5)).median,
      secondHalfMedianMs: stat(durations.slice(5)).median,
      finalMarker: final,
    }
    expect(turns.map((t) => t.reason)).toEqual(turns.map(() => 'done'))
    expect(turns.filter((t) => !t.recalled).map((t) => t.turn)).toEqual([])
  })

  test('opens and switches in the window once the conversation is long', async () => {
    const info = report.providers[provider.name]
    expect(info?.sessionId).toBeTruthy()
    const small = await newSession(provider, `Small ${provider.name}`)
    const smallMarker = `SMALL-${crypto.randomUUID().slice(0, 8)}`
    const from = host.events.length
    await host.rpc('sessions.prompt', {
      sessionId: small.id,
      text: `${smallMarker}: without tools, reply with only the single word PONG.`,
    })
    await host.wait(
      () =>
        host.events
          .slice(from)
          .some(({ event }) => event.sessionId === small.id && event.type === 'turn.completed'),
      120_000,
    )

    await page.goto(`http://127.0.0.1:${env.port}/`)
    await page.locator(`.session-row[href$="${info.sessionId}"]`).waitFor({ timeout: 30_000 })
    await page.locator(`.session-row[href$="${small.id}"]`).waitFor({ timeout: 30_000 })
    await takeLongTasks(page)

    const big = { id: info.sessionId as string, marker: info.finalMarker as string }
    const other = { id: small.id, marker: smallMarker }
    const firstOpen = await openSession(page, big)
    const samples: Sample[] = []
    for (let i = 0; i < 6; i++) {
      samples.push(await openSession(page, other))
      samples.push(await openSession(page, big))
    }
    const long = await takeLongTasks(page)
    const messages = await page.locator('main.thread .msg.user').count()
    const replies = await page.locator('main.thread .md').count()
    report.providers[provider.name] = {
      ...info,
      window: {
        firstOpen,
        switching: summarize(samples),
        longTasks: { count: long.length, totalMs: Math.round(long.reduce((a, b) => a + b, 0)) },
        userMessagesShown: messages,
        replyBlocksShown: replies,
      },
    }
    expect(messages).toBeGreaterThanOrEqual(10)
    expect(firstOpen.contentMs).toBeLessThan(3000)
  })
})
