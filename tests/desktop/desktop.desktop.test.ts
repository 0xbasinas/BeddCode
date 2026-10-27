import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { desktopEnv, launchDesktop, root } from './launch.ts'

let home = ''
let userData = ''
const stats: Record<string, unknown> = { startedAt: new Date().toISOString(), timings: {} }
const timings = stats.timings as Record<string, number>
const memory: { at: number; mib: number; processes: number }[] = []

let port = 0
let app: ElectronApplication
let page: Page
let sampler: NodeJS.Timeout | undefined

async function launch() {
  const launched = await launchDesktop({ home, userData, port })
  app = launched.app
  page = launched.page
  return launched.startedAt
}

async function sampleMemory() {
  try {
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
    const bytes = metrics.reduce((sum, m) => sum + m.memory.workingSetSize * 1024, 0)
    memory.push({ at: Date.now(), mib: Math.round(bytes / 1048576), processes: metrics.length })
  } catch {
    // The app is between launches.
  }
}

const bridge = <T>(run: (desktop: any) => Promise<T> | T) =>
  page.evaluate(`(${run.toString()})(window.beddcodeDesktop)`) as Promise<T>

const daemonStatus = async () =>
  ((await bridge((d) => d.daemon.status())) as { status: string }).status

async function waitForStatus(want: string[], timeout: number) {
  await expect
    .poll(() => daemonStatus().catch(() => 'unreachable'), { timeout, interval: 500 })
    .toSatisfy((status: string) => want.includes(status))
}

/** Process id listening on the host port. */
function hostPid(): number {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('powershell', [
            '-NoProfile',
            '-Command',
            `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
          ])
        : execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    return Number(out.toString().trim().split(/\s+/)[0]) || 0
  } catch {
    return 0
  }
}

/** Waits for the element to be on screen (vitest's expect has no locator matchers). */
const shown = (locator: Locator, timeout: number) =>
  locator.first().waitFor({ state: 'visible', timeout })

async function runFakeSession(prompt: string) {
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  await page.getByRole('button', { name: 'FA Fake agent' }).click()
  await page.getByLabel('Message').fill(prompt)
  await page.getByRole('button', { name: 'Send' }).click()
  await shown(page.getByText('Run the new test?'), 30_000)
  await page.getByRole('button', { name: 'Allow Enter' }).click()
  await shown(page.getByText('All tests pass.'), 30_000)
}

beforeAll(async () => {
  ;({ home, userData, port } = await desktopEnv())
  const started = await launch()
  timings.windowMs = Math.round(performance.now() - started)
  sampler = setInterval(() => void sampleMemory(), 2000)
})

afterAll(async () => {
  if (sampler) clearInterval(sampler)
  await app?.close().catch(() => {})
  const mibs = memory.map((m) => m.mib)
  stats.memorySummary = {
    samples: mibs.length,
    firstMiB: mibs[0],
    lastMiB: mibs.at(-1),
    peakMiB: mibs.length ? Math.max(...mibs) : undefined,
    peakProcesses: memory.length ? Math.max(...memory.map((m) => m.processes)) : undefined,
  }
  const dir = path.join(root, '.e2e', 'desktop-stats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${Date.now()}.json`), JSON.stringify({ ...stats, memory }, null, 2))
  rmSync(home, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

describe('BeddCode desktop app', () => {
  test('opens a window that loads the app from its own host', async () => {
    const started = performance.now()
    await shown(page.getByRole('heading', { name: 'Welcome to BeddCode' }), 90_000)
    timings.uiReadyMs = Math.round(performance.now() - started + (timings.windowMs ?? 0))
    expect(await page.title()).toContain('BeddCode')
    expect(page.url()).toBe(`http://127.0.0.1:${port}/`)
  })

  test('exposes the desktop bridge and keeps the page sandboxed', async () => {
    const info = await bridge((d) => ({
      platform: d?.platform,
      keys: Object.keys(d ?? {}).sort(),
      node: typeof (globalThis as any).require,
    }))
    expect(info.platform).toBe(process.platform)
    expect(info.keys).toEqual(expect.arrayContaining(['browser', 'daemon', 'pickFolder', 'window']))
    expect(info.node).toBe('undefined')
  })

  test('supervises a local host that the app started', async () => {
    await waitForStatus(['running', 'attached'], 30_000)
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true)
  })

  test('window buttons maximize, restore and minimize', async () => {
    const maximized = () => bridge((d) => d.window.isMaximized())
    const before = await maximized()
    await bridge((d) => d.window.toggleMaximize())
    await expect.poll(maximized, { timeout: 10_000 }).toBe(!before)
    await bridge((d) => d.window.toggleMaximize())
    await expect.poll(maximized, { timeout: 10_000 }).toBe(before)
    await bridge((d) => d.window.minimize())
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()),
      )
      .toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore())
  })

  test('runs a streamed session with an approval inside the desktop window', async () => {
    await page.getByRole('button', { name: 'Skip setup' }).click()
    const started = performance.now()
    await runFakeSession('Desktop: check the sample project')
    timings.sessionMs = Math.round(performance.now() - started)
    await sampleMemory()
  })

  test('recovers when the local host is killed', async () => {
    const pid = hostPid()
    expect(pid).toBeGreaterThan(0)
    const killed = performance.now()
    process.kill(pid, 'SIGKILL')
    await expect
      .poll(hostPid, { timeout: 90_000, interval: 500 })
      .toSatisfy((next: number) => next > 0 && next !== pid)
    await waitForStatus(['running'], 90_000)
    timings.hostRecoveryMs = Math.round(performance.now() - killed)
    await page.reload()
    await shown(page.getByText('All tests pass.'), 60_000)
  })

  test('restarts the host on request', async () => {
    const before = hostPid()
    const restarted = performance.now()
    await bridge((d) => d.daemon.restart())
    await expect
      .poll(hostPid, { timeout: 60_000, interval: 500 })
      .toSatisfy((next: number) => next > 0 && next !== before)
    await waitForStatus(['running'], 60_000)
    timings.hostRestartMs = Math.round(performance.now() - restarted)
  })

  test('keeps the session after the app is closed and opened again', async () => {
    await app.close()
    const started = await launch()
    timings.relaunchWindowMs = Math.round(performance.now() - started)
    const entry = page.getByText('Desktop: check the sample project').first()
    await shown(entry, 90_000)
    await entry.click()
    timings.relaunchUiMs = Math.round(performance.now() - started)
    await shown(page.getByText('All tests pass.'), 30_000)
  })
})
