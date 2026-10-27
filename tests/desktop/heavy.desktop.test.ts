import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Host } from '../shared/hostClient.ts'
import { desktopEnv, launchDesktop, root, type DesktopEnv } from './launch.ts'
import {
  frameStats,
  openSession,
  scrollThrough,
  searchSidebar,
  startFrames,
  stopFrames,
  summarize,
  takeLongTasks,
  type Sample,
  type Session,
} from './ui.ts'

// Heavy content in the desktop window with the fake agent, so every run is identical: a session of
// 120 messages with large command output and diffs, a sidebar of 300 sessions, and 5 sessions
// streaming text while you switch between them.
const HEAVY_TURNS = Number(process.env.DESKTOP_HEAVY_TURNS) || 60
const BULK = Number(process.env.DESKTOP_BULK_SESSIONS) || 300
const STREAMING = 5

let env: DesktopEnv
let app: ElectronApplication
let page: Page
let host: Host
let hostOpen = false
const run = crypto.randomUUID().slice(0, 6)
const bulk: Session[] = []
const streaming: Session[] = []
let heavy: Session
const results: Record<string, any> = {}
const memory: number[] = []
let sampler: NodeJS.Timeout | undefined

const url = () => `http://127.0.0.1:${env.port}/`

async function createSession(title: string) {
  const created = await host.rpc('sessions.create', {
    instanceId: 'fake',
    projectless: true,
    permissionMode: 'acceptEdits',
    title,
  })
  return created.sessionId as string
}

async function turn(sessionId: string, text: string, wait = true) {
  const from = host.events.length
  await host.rpc('sessions.prompt', { sessionId, text })
  if (!wait) return
  await host.wait(
    () =>
      host.events
        .slice(from)
        .some(({ event }) => event.sessionId === sessionId && event.type === 'turn.completed'),
    120_000,
  )
}

/** Runs `work` for every item, `limit` at a time. */
async function pooled<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item)
    }),
  )
}

async function stopRunning() {
  const open = new Set(
    host.events
      .filter(({ event }) => event.type === 'turn.started')
      .map(({ event }) => event.sessionId),
  )
  for (const { event } of host.events)
    if (event.type === 'turn.completed') open.delete(event.sessionId)
  await Promise.all(
    [...open].map((id) => host.rpc('sessions.interrupt', { sessionId: id }).catch(() => {})),
  )
}

/** Opens every target `rounds` times (rotating), logging frames and long tasks around it. */
async function timed(name: string, targets: Session[], rounds = 3) {
  await takeLongTasks(page)
  await startFrames(page)
  const samples: Sample[] = []
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < targets.length; i++) {
      samples.push(await openSession(page, targets[(i * 2 + r) % targets.length]!))
    }
  }
  const frames = frameStats(await stopFrames(page))
  const long = await takeLongTasks(page)
  results[name] = {
    ...summarize(samples),
    frames,
    longTasks: { count: long.length, totalMs: Math.round(long.reduce((a, b) => a + b, 0)) },
  }
}

beforeAll(async () => {
  env = await desktopEnv()
  const launched = await launchDesktop(env)
  app = launched.app
  page = launched.page
  await page.getByRole('heading', { name: 'Welcome to BeddCode' }).waitFor({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Skip setup' }).click()
  host = new Host(`ws://127.0.0.1:${env.port}/ws`)
  await host.connect()
  hostOpen = true
  sampler = setInterval(async () => {
    try {
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
      memory.push(Math.round(metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024))
    } catch {
      // The app is between launches.
    }
  }, 2000)

  const began = performance.now()
  await Promise.all([
    // One long session: every fifth turn carries large output, diffs and a big reply.
    (async () => {
      const id = await createSession(`Heavy ${run}`)
      for (let n = 1; n <= HEAVY_TURNS; n++) {
        const marker = `HEAVY-${run}-${n}`
        await turn(
          id,
          `${n % 5 === 0 ? '[heavy] ' : ''}Heavy turn ${n} of ${HEAVY_TURNS} ${marker}`,
        )
        if (n === HEAVY_TURNS) heavy = { id, marker }
      }
    })(),
    // A long sidebar of ordinary finished sessions.
    pooled(
      Array.from({ length: BULK }, (_, i) => i + 1),
      20,
      async (i) => {
        const id = await createSession(`Bulk ${run} ${i}`)
        const marker = `BULK-${run}-${i}`
        bulk[i - 1] = { id, marker }
        await turn(id, `Quick task ${i} ${marker}`)
      },
    ),
  ])
  results.setupMs = Math.round(performance.now() - began)
  // Sessions that stream until they are interrupted.
  for (let i = 1; i <= STREAMING; i++) {
    const marker = `STREAM-${run}-${i}`
    const id = await createSession(`Streaming ${run} ${i}`)
    streaming.push({ id, marker })
    await turn(id, `[stream:300] Streaming session ${i} ${marker}`, false)
  }
  await page.goto(url())
  await page.locator('.session-row').first().waitFor({ timeout: 30_000 })
  await takeLongTasks(page)
}, 600_000)

afterAll(async () => {
  if (sampler) clearInterval(sampler)
  if (hostOpen) await stopRunning()
  host?.close()
  await app?.close().catch(() => {})
  results.electronMemoryMiB = {
    samples: memory.length,
    first: memory[0],
    peak: memory.length ? Math.max(...memory) : undefined,
    last: memory.at(-1),
  }
  const dir = path.join(root, '.e2e', 'desktop-stats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, `heavy-${Date.now()}.json`),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        workload: { HEAVY_TURNS, BULK, STREAMING },
        ...results,
      },
      null,
      2,
    ),
  )
  for (const folder of [env?.home, env?.userData]) {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
}, 120_000)

describe('heavy content in the desktop window', () => {
  test(`switching between ${STREAMING} sessions that are streaming`, async () => {
    await timed('switchStreaming', streaming, 4)
    expect(results.switchStreaming.content.median).toBeLessThan(1500)
  })

  test('opening the 120-message session while the others stream', async () => {
    await timed('openHeavyWhileStreaming', [heavy, streaming[0]!, heavy, streaming[1]!], 3)
    expect(results.openHeavyWhileStreaming.content.median).toBeLessThan(3000)
  })

  test('the streams stop when interrupted', async () => {
    await stopRunning()
    await expect
      .poll(() => page.locator('.session-row [aria-label="Working"]').count(), { timeout: 30_000 })
      .toBe(0)
  })

  test('opening and scrolling the 120-message session', async () => {
    await timed('openHeavy', [heavy, bulk[0]!, heavy, bulk[1]!], 3)
    await openSession(page, heavy)
    const dom = await page.evaluate(() => ({
      nodes: document.querySelectorAll('*').length,
      heapMiB: Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576),
    }))
    await startFrames(page)
    const scroll = await scrollThrough(page, 'main.thread')
    const frames = frameStats(await stopFrames(page))
    results.heavySession = {
      userMessages: await page.locator('main.thread .msg.user').count(),
      domNodes: dom.nodes,
      jsHeapMiB: dom.heapMiB,
      scroll,
      scrollFrames: frames,
    }
    expect(scroll.scrollable).toBe(true)
  })

  test('showing the whole 120-message session', async () => {
    await openSession(page, heavy)
    await takeLongTasks(page)
    const began = performance.now()
    let clicks = 0
    while (clicks < 30) {
      const more = page.locator('main.thread .show-earlier').first()
      if (!(await more.isVisible().catch(() => false))) break
      await more.click()
      clicks++
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
    }
    const expandMs = performance.now() - began
    const long = await takeLongTasks(page)
    const dom = await page.evaluate(() => ({
      nodes: document.querySelectorAll('*').length,
      heapMiB: Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576),
    }))
    await startFrames(page)
    const scroll = await scrollThrough(page, 'main.thread')
    const frames = frameStats(await stopFrames(page))
    const reopen = await openSession(page, bulk[2]!).then(() => openSession(page, heavy))
    results.heavySessionExpanded = {
      showEarlierClicks: clicks,
      expandMs: Math.round(expandMs),
      longTasks: { count: long.length, totalMs: Math.round(long.reduce((a, b) => a + b, 0)) },
      userMessages: await page.locator('main.thread .msg.user').count(),
      domNodes: dom.nodes,
      jsHeapMiB: dom.heapMiB,
      scroll,
      scrollFrames: frames,
      reopen,
    }
    expect(results.heavySessionExpanded.userMessages).toBeGreaterThanOrEqual(HEAVY_TURNS)
  })

  test(`a sidebar with ${BULK + STREAMING + 1} sessions`, async () => {
    const began = performance.now()
    await page.goto(url())
    await page.locator('.session-row').first().waitFor({ timeout: 30_000 })
    const firstRowMs = performance.now() - began
    await expect
      .poll(() => page.locator('.session-row').count(), { timeout: 30_000 })
      .toBeGreaterThan(Math.min(BULK, 50))
    const rowsInDom = await page.locator('.session-row').count()
    await startFrames(page)
    const scroll = await scrollThrough(page, '.session-row')
    const scrollFrames = frameStats(await stopFrames(page))
    const searches: Record<string, unknown> = {}
    for (const query of [`Bulk ${run} 29`, 'Quick', 'zzz-no-match']) {
      searches[query] = await searchSidebar(page, query)
    }
    results.sidebar = {
      sessions: BULK + STREAMING + 1,
      firstRowMs: Math.round(firstRowMs),
      rowsInDom,
      scroll,
      scrollFrames,
      searches,
    }
  })

  test('opening sessions from the long sidebar', async () => {
    const picks = [0, 50, 100, 150, 200, 250, 299].map((i) => bulk[Math.min(i, bulk.length - 1)]!)
    await timed('openFromLongList', picks, 3)
    expect(results.openFromLongList.content.median).toBeLessThan(1500)
  })

  test('relaunching with all of it', async () => {
    await stopRunning()
    host.close()
    hostOpen = false
    await app.close()
    const launched = await launchDesktop(env)
    app = launched.app
    page = launched.page
    await page.locator('.session-row').first().waitFor({ timeout: 90_000 })
    const firstRowMs = performance.now() - launched.startedAt
    const sample = await openSession(page, heavy)
    results.coldStart = { firstRowMs: Math.round(firstRowMs), heavySessionOpen: sample }
    expect(firstRowMs).toBeLessThan(60_000)
  })
})
