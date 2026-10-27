import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Host } from '../shared/hostClient.ts'
import { desktopEnv, launchDesktop, root, type DesktopEnv } from './launch.ts'

// Real agent CLIs inside the real desktop app. Session counts are small by default (2 Claude,
// 3 Grok) so the tests themselves can be checked cheaply; raise them with the environment variables.
const providers = [
  {
    name: 'claude',
    id: 'claude',
    menu: 'CC Claude Code',
    mode: 'default',
    count: Number(process.env.DESKTOP_CLAUDE_SESSIONS) || 2,
  },
  {
    name: 'codex',
    id: 'codex',
    menu: 'C Codex',
    mode: 'read-only',
    count: Number(process.env.DESKTOP_CODEX_SESSIONS) || 2,
  },
  {
    name: 'grok',
    id: 'acp:grok',
    menu: 'G Grok',
    mode: 'ask',
    count: Number(process.env.DESKTOP_GROK_SESSIONS) || 3,
  },
].filter((p) => (process.env.DESKTOP_PROVIDERS ?? 'claude,grok').split(',').includes(p.name))

const quantile = (values: number[], q: number) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!)
}

let env: DesktopEnv
let app: ElectronApplication
let page: Page
let host: Host
const report: Record<string, any> = { startedAt: new Date().toISOString(), providers: {} }
const memory: { at: number; electronMiB: number; freeSystemMiB: number }[] = []
let sampler: NodeJS.Timeout | undefined

beforeAll(async () => {
  env = await desktopEnv(true)
  const launched = await launchDesktop(env, true)
  app = launched.app
  page = launched.page
  await page.getByRole('heading', { name: 'Welcome to BeddCode' }).waitFor({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Skip setup' }).click()
  host = new Host(`ws://127.0.0.1:${env.port}/ws`)
  await host.connect()
  sampler = setInterval(async () => {
    try {
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
      const kib = metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0)
      memory.push({
        at: Date.now(),
        electronMiB: Math.round(kib / 1024),
        freeSystemMiB: Math.round(os.freemem() / 1048576),
      })
    } catch {
      // The app is closing.
    }
  }, 2000)
})

afterAll(async () => {
  if (sampler) clearInterval(sampler)
  host?.close()
  await app?.close().catch(() => {})
  const electron = memory.map((m) => m.electronMiB)
  report.memory = {
    samples: memory.length,
    electronPeakMiB: electron.length ? Math.max(...electron) : null,
    minSystemFreeMiB: memory.length ? Math.min(...memory.map((m) => m.freeSystemMiB)) : null,
  }
  const dir = path.join(root, '.e2e', 'desktop-stats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `real-${Date.now()}.json`), JSON.stringify(report, null, 2))
  for (const folder of [env?.home, env?.userData]) {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
})

describe.each(providers)('$name in the desktop app', (provider) => {
  test('a prompt typed in the window gets a response', async () => {
    await page.goto(`http://127.0.0.1:${env.port}/#/?compose=true`)
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    await page.getByRole('button', { name: provider.menu }).click()
    await page
      .getByLabel('Message')
      .fill('Without using tools, reply with only the single word PONG.')
    const sent = performance.now()
    await page.getByRole('button', { name: 'Send' }).click()
    await page.locator('.md', { hasText: 'PONG' }).first().waitFor({ timeout: 120_000 })
    const answered = performance.now() - sent
    await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'hidden', timeout: 120_000 })
    report.providers[provider.name] = {
      ...report.providers[provider.name],
      uiAnswerMs: Math.round(answered),
    }
  })

  test(`${provider.count} concurrent sessions complete while the window stays responsive`, async () => {
    await page.goto(`http://127.0.0.1:${env.port}/`)
    const markers = Array.from(
      { length: provider.count },
      (_, i) => `BUG-${i + 1}-${crypto.randomUUID().slice(0, 8)}`,
    )
    const sessions = await Promise.all(
      markers.map(async (marker, index) => {
        const title = `Desktop ${provider.name} ${index + 1}`
        const created = await host.rpc('sessions.create', {
          instanceId: provider.id,
          projectless: true,
          permissionMode: provider.mode,
          title,
        })
        const isCreated = ({ event }: any) =>
          event.type === 'session.created' && event.sessionId === created.sessionId
        await host.wait(() => host.events.some(isCreated), 15_000)
        const cwd = host.events.find(isCreated)!.event.cwd as string
        const fixture = `// ${marker}\nexport function reserveStock(stock: number, quantity: number): number {\n  if (quantity <= 0) throw new Error('quantity must be positive')\n  return stock - quantity\n}\n`
        await host.rpc('files.create', { cwd, path: 'inventory.ts', type: 'file' })
        await host.rpc('files.write', { cwd, path: 'inventory.ts', content: fixture })
        return { id: created.sessionId as string, title, marker }
      }),
    )

    // How quickly the window answers while the agents work: one round trip per sample.
    const frameMs: number[] = []
    const probe = setInterval(async () => {
      const began = performance.now()
      try {
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
        frameMs.push(performance.now() - began)
      } catch {
        // The page is navigating.
      }
    }, 500)

    const from = host.events.length
    const sentAt = performance.now()
    await Promise.all(
      sessions.map((s) =>
        host.rpc('sessions.prompt', {
          sessionId: s.id,
          text: 'Read inventory.ts in this workspace. Identify the bug and report its BUG identifier from the file. Briefly explain the consequence. Do not edit files or run tests.',
        }),
      ),
    )
    const records = () => host.events.slice(from)
    const done = (id: string) =>
      records().some(({ event }) => event.sessionId === id && event.type === 'turn.completed')
    const stopped = new Set<string>()
    const deadline = Date.now() + 150_000
    while (!sessions.every((s) => done(s.id)) && Date.now() < deadline) {
      for (const { event } of records()) {
        const key = `${event.sessionId}:${event.requestId}`
        if (event.type === 'approval.requested' && !stopped.has(key)) {
          stopped.add(key)
          await host.rpc('sessions.interrupt', { sessionId: event.sessionId })
        }
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    clearInterval(probe)

    const perSession = sessions.map((s) => {
      const mine = records().filter(({ event }) => event.sessionId === s.id)
      const end = mine.find(({ event }) => event.type === 'turn.completed')?.event
      const text = mine
        .filter(({ event }) => event.type === 'message.delta' && event.role === 'assistant')
        .map(({ event }) => event.text)
        .join('')
      return {
        title: s.title,
        reason: end?.reason ?? 'timeout',
        durationMs: end ? Math.round(end.at - mine[0]!.event.at) : null,
        toolCalls: mine.filter(({ event }) => event.type === 'tool.started').length,
        foundMarker: text.includes(s.marker),
      }
    })
    let active = 0
    let peak = 0
    for (const { event } of records()) {
      if (event.type === 'turn.started') peak = Math.max(peak, ++active)
      if (event.type === 'turn.completed') active--
    }

    // The window lists every session the host is running.
    // Some agents retitle their sessions, so compare the sidebar's total with the host's.
    const created = new Set(
      host.events
        .filter(({ event }) => event.type === 'session.created')
        .map(({ event }) => event.sessionId),
    ).size
    const listedCount = () =>
      page
        .innerText('body')
        .then((text) => Number(/All\s+(\d+)/.exec(text)?.[1] ?? 0))
        .catch(() => 0)
    await expect
      .poll(listedCount, { timeout: 30_000, interval: 500 })
      .toBeGreaterThanOrEqual(created)

    report.providers[provider.name] = {
      ...report.providers[provider.name],
      concurrent: {
        sessions: provider.count,
        wallMs: Math.round(performance.now() - sentAt),
        peakOverlap: peak,
        perSession,
        frameMs: {
          samples: frameMs.length,
          median: quantile(frameMs, 0.5),
          p95: quantile(frameMs, 0.95),
          max: quantile(frameMs, 1),
        },
      },
    }
    expect(perSession.map((s) => s.reason)).toEqual(sessions.map(() => 'done'))
    expect(perSession.every((s) => s.foundMarker)).toBe(true)
    expect(peak).toBe(provider.count)
  })
})
