import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Host } from '../shared/hostClient.ts'
import { agentBackend, type Backend } from './deepseek.ts'
import { desktopEnv, launchDesktop, root, type DesktopEnv } from './launch.ts'
import {
  frameStats,
  openSession,
  profilePage,
  startFrames,
  stat,
  stopFrames,
  summarize,
  takeLongFrames,
  takeLongTasks,
  type Sample,
  type Session,
} from './ui.ts'

// Real agent CLIs streaming long answers into five sessions at once while the desktop window
// switches between them. Runs on DeepSeek unless DESKTOP_BACKEND=native (see deepseek.ts).
const providers = [
  { name: 'claude', id: 'claude', mode: 'default' },
  { name: 'codex', id: 'codex', mode: 'read-only' },
  { name: 'grok', id: 'acp:grok', mode: 'ask' },
].filter((p) => (process.env.DESKTOP_PROVIDERS ?? 'claude,codex,grok').split(',').includes(p.name))
const SESSIONS = Number(process.env.DESKTOP_HEAVY_SESSIONS) || 5

const longPrompt = (marker: string, part: number) =>
  `${marker} part ${part}. Without using any tools, write a detailed explanation of how a token-bucket rate limiter works, at least 500 words, then a TypeScript implementation of about 60 lines in a code block, then a table of five edge cases. Do not stop early.`

let env: DesktopEnv
let backend: Backend
let app: ElectronApplication
let page: Page
let host: Host
const report: Record<string, any> = { startedAt: new Date().toISOString(), providers: {} }
const memory: number[] = []
let sampler: NodeJS.Timeout | undefined

beforeAll(async () => {
  backend = agentBackend()
  report.backend = backend.name
  env = await desktopEnv(true)
  const launched = await launchDesktop(env, true, backend.env)
  app = launched.app
  page = launched.page
  await page.getByRole('heading', { name: 'Welcome to BeddCode' }).waitFor({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Skip setup' }).click()
  host = new Host(`ws://127.0.0.1:${env.port}/ws`)
  await host.connect()
  sampler = setInterval(async () => {
    try {
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
      memory.push(Math.round(metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024))
    } catch {
      // The app is closing.
    }
  }, 2000)
})

afterAll(async () => {
  if (sampler) clearInterval(sampler)
  host?.close()
  await app?.close().catch(() => {})
  backend?.cleanup()
  report.electronMemoryMiB = {
    samples: memory.length,
    first: memory[0],
    peak: memory.length ? Math.max(...memory) : undefined,
    last: memory.at(-1),
  }
  const dir = path.join(root, '.e2e', 'desktop-stats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `heavy-real-${Date.now()}.json`), JSON.stringify(report, null, 2))
  for (const folder of [env?.home, env?.userData]) {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
})

describe.each(providers)('$name: streaming sessions while switching', (provider) => {
  test(`${SESSIONS} long answers stream while the window switches between them`, async () => {
    const tag = crypto.randomUUID().slice(0, 6)
    const sessions: (Session & { title: string })[] = []
    for (let i = 1; i <= SESSIONS; i++) {
      const title = `Heavy ${provider.name} ${tag} ${i}`
      const created = await host.rpc('sessions.create', {
        instanceId: provider.id,
        projectless: true,
        permissionMode: provider.mode,
        title,
      })
      sessions.push({ id: created.sessionId, marker: `LONG-${tag}-${i}`, title })
    }
    await page.goto(`http://127.0.0.1:${env.port}/`)
    for (const s of sessions)
      await page.locator(`.session-row[href$="${s.id}"]`).waitFor({ timeout: 30_000 })

    const from = host.events.length
    const sentAt = Date.now()
    await Promise.all(
      sessions.map((s) =>
        host.rpc('sessions.prompt', { sessionId: s.id, text: longPrompt(s.marker, 1) }),
      ),
    )
    const mine = (id: string) =>
      host.events.slice(from).filter(({ event }) => event.sessionId === id)
    const done = (id: string) => mine(id).some(({ event }) => event.type === 'turn.completed')
    const stopped = new Set<string>()

    // Switch between the sessions for as long as any of them is still streaming.
    await takeLongTasks(page)
    await takeLongFrames(page)
    await startFrames(page)
    const profiler = process.env.DESKTOP_PROFILE === '1' ? await profilePage(page) : null
    const during: Sample[] = []
    const deadline = Date.now() + 240_000
    for (let n = 0; Date.now() < deadline && !sessions.every((s) => done(s.id)); n++) {
      during.push(await openSession(page, sessions[n % sessions.length]!))
      for (const { event } of host.events.slice(from)) {
        const key = `${event.sessionId}:${event.requestId}`
        if (event.type === 'approval.requested' && !stopped.has(key)) {
          stopped.add(key)
          await host.rpc('sessions.interrupt', { sessionId: event.sessionId })
        }
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    const profile = profiler ? await profiler.stop() : null
    if (profile) {
      const dir = path.join(root, '.e2e', 'desktop-stats')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        path.join(dir, `${provider.name}-${Date.now()}.cpuprofile`),
        JSON.stringify(profile.raw),
      )
      report.providers[provider.name] = { hottest: profile.hottest }
    }
    const duringFrames = frameStats(await stopFrames(page))
    const duringLong = await takeLongTasks(page)
    const duringLongFrames = await takeLongFrames(page)

    const perSession = sessions.map((s) => {
      const events = mine(s.id).map(({ event }) => event)
      const end = events.find((e) => e.type === 'turn.completed')
      const chars = events
        .filter((e) => e.type === 'message.delta' && e.role === 'assistant')
        .reduce((sum, e) => sum + (e.text?.length ?? 0), 0)
      const first = events.find((e) => e.type === 'message.delta' && e.role === 'assistant')
      return {
        reason: end?.reason ?? 'timeout',
        durationMs: end ? end.at - sentAt : null,
        firstResponseMs: first ? first.at - sentAt : null,
        chars,
        charsPerSecond:
          end && end.at > sentAt ? Math.round((chars / (end.at - sentAt)) * 1000) : null,
        deltas: events.filter((e) => e.type === 'message.delta').length,
      }
    })

    // Afterwards: the finished, now much larger, sessions.
    await takeLongTasks(page)
    await startFrames(page)
    const after: Sample[] = []
    for (let r = 0; r < 3; r++) for (const s of sessions) after.push(await openSession(page, s))
    const afterFrames = frameStats(await stopFrames(page))
    const afterLong = await takeLongTasks(page)

    report.providers[provider.name] = {
      ...report.providers[provider.name],
      sessions: SESSIONS,
      perSession,
      duringStreaming: {
        switches: during.length,
        ...(during.length ? summarize(during) : {}),
        frames: duringFrames,
        longFrames: duringLongFrames.map((f) => ({
          ...f,
          afterPromptMs: f.epochMs - sentAt,
          // What the host was sending in the second around the stall.
          eventsAround: host.events
            .slice(from)
            .filter(({ event }) => Math.abs(event.at - f.epochMs) < 1000)
            .reduce(
              (n: Record<string, number>, { event }) => (
                (n[event.type] = (n[event.type] ?? 0) + 1),
                n
              ),
              {},
            ),
        })),
        longTasks: {
          count: duringLong.length,
          totalMs: Math.round(duringLong.reduce((a, b) => a + b, 0)),
        },
      },
      afterStreaming: {
        ...summarize(after),
        frames: afterFrames,
        longTasks: {
          count: afterLong.length,
          totalMs: Math.round(afterLong.reduce((a, b) => a + b, 0)),
        },
      },
      answerChars: stat(perSession.map((p) => p.chars)),
    }
    expect(perSession.map((p) => p.reason)).toEqual(sessions.map(() => 'done'))
    expect(perSession.every((p) => p.chars > 1500)).toBe(true)
    expect(during.length).toBeGreaterThan(0)
  })
})
