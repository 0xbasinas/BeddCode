import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Host } from '../shared/hostClient.ts'
import { desktopEnv, launchDesktop, root, type DesktopEnv } from './launch.ts'
import {
  openComposer,
  openSession,
  summarize,
  takeLongTasks,
  type Sample,
  type Session,
} from './ui.ts'

// How fast the desktop window opens and switches sessions. The fake agent keeps the workload
// identical between runs: finished sessions, sessions held in "running" and one 10-turn session.
const FINISHED = 6
const RUNNING = 6
const BIG_TURNS = 10
const ROUNDS = 3

type Target = Session & { title: string }

let env: DesktopEnv
let app: ElectronApplication
let page: Page
let host: Host
let hostOpen = false
const run = crypto.randomUUID().slice(0, 6)
const finished: Target[] = []
const running: Target[] = []
let big: Target
const results: Record<string, any> = {}

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
    60_000,
  )
}

async function measure(name: string, targets: Target[]) {
  await takeLongTasks(page)
  const samples: Sample[] = []
  for (const target of targets) samples.push(await openSession(page, target))
  const long = await takeLongTasks(page)
  results[name] = {
    ...summarize(samples),
    longTasks: { count: long.length, totalMs: Math.round(long.reduce((a, b) => a + b, 0)) },
  }
  return samples
}

/** Every target `ROUNDS` times in a rotating order, so no session is always first or last. */
const rounds = (targets: Target[]) =>
  Array.from({ length: ROUNDS }, (_, r) =>
    targets.map((_, i) => targets[(i * 2 + r) % targets.length]!),
  ).flat()

/** Interrupts every turn that is still running (the held sessions). */
async function stopHeldSessions() {
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

  const setupStarted = performance.now()
  const prompts: Promise<void>[] = []
  for (let i = 1; i <= FINISHED; i++) {
    const title = `Finished ${run} ${i}`
    const marker = `FIN-${run}-${i}`
    prompts.push(
      createSession(title).then(async (id) => {
        finished[i - 1] = { id, title, marker }
        await turn(id, `Finished session ${i} ${marker}`)
      }),
    )
  }
  prompts.push(
    createSession(`Big ${run}`).then(async (id) => {
      big = { id, title: `Big ${run}`, marker: `BIG-${run}-${BIG_TURNS}` }
      for (let n = 1; n <= BIG_TURNS; n++) {
        const tag = n === BIG_TURNS ? big.marker : `BIG-${run}-${n}`
        await turn(
          id,
          `Turn ${n} of ${BIG_TURNS}. ${tag}. Please look at the rate limiter, explain what you find and suggest the next small change. `.repeat(
            2,
          ),
        )
      }
    }),
  )
  await Promise.all(prompts)
  // Held sessions stay "running" until they are interrupted at the end.
  for (let i = 1; i <= RUNNING; i++) {
    const t = { title: `Running ${run} ${i}`, marker: `RUN-${run}-${i}` }
    const id = await createSession(t.title)
    running.push({ id, ...t })
    await turn(id, `[hold] Running session ${i} ${t.marker}`, false)
  }
  results.setupMs = Math.round(performance.now() - setupStarted)
  await page.goto(`http://127.0.0.1:${env.port}/`)
  await page
    .locator('.session-row')
    .nth(FINISHED + RUNNING)
    .waitFor({ timeout: 30_000 })
  await takeLongTasks(page)
})

afterAll(async () => {
  if (hostOpen) await stopHeldSessions()
  host?.close()
  await app?.close().catch(() => {})
  const dir = path.join(root, '.e2e', 'desktop-stats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, `perf-${Date.now()}.json`),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        workload: { FINISHED, RUNNING, BIG_TURNS, ROUNDS },
        ...results,
      },
      null,
      2,
    ),
  )
  for (const folder of [env?.home, env?.userData]) {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
})

describe('desktop session performance', () => {
  test('sessions held running are shown as working', async () => {
    const working = await page.locator('.session-row [aria-label="Working"]').count()
    expect(working).toBeGreaterThanOrEqual(RUNNING)
  })

  test('switching between running sessions', async () => {
    const samples = await measure('switchRunning', rounds(running))
    expect(samples).toHaveLength(RUNNING * ROUNDS)
    expect(results.switchRunning.content.median).toBeLessThan(1500)
  })

  test('switching between a running and a finished session', async () => {
    const mixed = running.flatMap((r, i) => [r, finished[i]!])
    const samples = await measure('switchRunningFinished', [...mixed, ...mixed, ...mixed])
    expect(samples).toHaveLength(mixed.length * ROUNDS)
    expect(results.switchRunningFinished.content.median).toBeLessThan(1500)
  })

  test('opening finished sessions', async () => {
    await measure('openFinished', rounds(finished))
    expect(results.openFinished.content.median).toBeLessThan(1500)
  })

  test(`opening the ${BIG_TURNS}-turn session`, async () => {
    const targets: Target[] = []
    for (let i = 0; i < ROUNDS * 2; i++) targets.push(finished[i % finished.length]!, big)
    const samples: Sample[] = []
    await takeLongTasks(page)
    for (const target of targets) {
      const sample = await openSession(page, target)
      if (target === big) samples.push(sample)
    }
    const items = await openSession(page, big).then(() => page.locator('main.thread .msg').count())
    results.openBigSession = { ...summarize(samples), renderedMessages: items }
    expect(results.openBigSession.content.median).toBeLessThan(2000)
  })

  test('opening a new-session composer', async () => {
    const samples: Sample[] = []
    for (let i = 0; i < 10; i++) {
      await openSession(page, finished[i % finished.length]!)
      samples.push(await openComposer(page))
    }
    results.openComposer = summarize(samples)
    expect(results.openComposer.content.median).toBeLessThan(1500)
  })

  test('relaunching the app and opening the big session', async () => {
    await stopHeldSessions()
    host.close()
    hostOpen = false
    await app.close()
    const launched = await launchDesktop(env)
    app = launched.app
    page = launched.page
    await page
      .locator('.session-row')
      .nth(FINISHED + RUNNING)
      .waitFor({ timeout: 90_000 })
    const listed = performance.now() - launched.startedAt
    const sample = await openSession(page, big)
    results.coldStart = { sidebarReadyMs: Math.round(listed), bigSessionOpen: sample }
    expect(listed).toBeLessThan(60_000)
  })
})
