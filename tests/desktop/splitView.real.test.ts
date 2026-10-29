// Sessions side by side with the real agent CLIs: one session each for Claude Code, Codex and
// Grok, then a session dragged from the list beside the open one, another opened beside them from
// the row's menu, and a message sent in a side pane. Uses provider quota, so it runs only through
// `pnpm test:desktop:real`; SPLIT_SCREENSHOT saves a picture of the three panes.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { desktopEnv, type DesktopEnv, freePort, launchDesktop, root } from './launch.ts'

const agents = [
  { name: 'claude', label: 'Claude Code' },
  { name: 'codex', label: 'Codex' },
  { name: 'grok', label: 'Grok' },
].filter((a) => (process.env.DESKTOP_PROVIDERS ?? 'claude,codex,grok').split(',').includes(a.name))

const bundle = path.join(root, 'apps/desktop/build/host')
const fromBundle = existsSync(path.join(bundle, 'server/main.mjs'))

let env: DesktopEnv
let host: ChildProcess
let app: ElectronApplication
let page: Page
let project: string
const sessions: { id: string; title: string; agent: string }[] = []

beforeAll(async () => {
  env = await desktopEnv(true)
  env.port = Number(process.env.BEDDCODE_TEST_PORT) || (await freePort())
  project = path.join(env.home, 'demo-app')
  mkdirSync(project, { recursive: true })
  writeFileSync(path.join(project, 'README.md'), '# demo-app\n')
  // The bundled host when built (pnpm --filter @beddcode/desktop host), else the source.
  const args = fromBundle
    ? [path.join(bundle, 'server/main.mjs')]
    : ['--import', 'tsx', path.join(root, 'apps/server/src/main.ts')]
  host = spawn(
    process.execPath,
    [...args, 'serve', '--port', String(env.port), '--host', '127.0.0.1'],
    {
      cwd: fromBundle ? root : path.join(root, 'apps/server'),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        BEDDCODE_HOME: env.home,
        BEDDCODE_WEB_ROOT: fromBundle ? path.join(bundle, 'web') : path.join(root, 'apps/web/dist'),
        BEDDCODE_TELEMETRY: '0',
      },
      stdio: 'ignore',
    },
  )
  for (let i = 0; ; i++) {
    const up = await fetch(`http://127.0.0.1:${env.port}/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (up) break
    if (i > 60) throw new Error('the test host did not start')
    await new Promise((r) => setTimeout(r, 500))
  }
  const launched = await launchDesktop(env, true, { BEDDCODE_HOST_MODE: 'external' })
  app = launched.app
  page = launched.page
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.unmaximize()
    win?.setBounds({ x: 0, y: 0, width: 1680, height: 960 })
  })
  await page.getByRole('button', { name: 'Skip setup' }).click({ timeout: 90_000 })
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  host?.kill('SIGTERM')
  for (const folder of [env?.home, env?.userData]) {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
})

const sum = (n: number) => String(n + 111 + (n + 222))

describe('sessions side by side', () => {
  test.each(agents)('a $name session answers', async (agent) => {
    await page.goto(
      `http://127.0.0.1:${env.port}/#/?compose=true&project=${encodeURIComponent(project)}`,
    )
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    await page.getByText(agent.label, { exact: true }).last().click()
    const base = 1000 * (agents.indexOf(agent) + 2)
    await page
      .getByLabel('Message')
      .fill(
        `Without using tools, reply with only the sum of ${base + 111} and ${base + 222}, as digits.`,
      )
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForURL(/#\/session\//, { timeout: 60_000 })
    const id = decodeURIComponent(/#\/session\/([^/?]+)/.exec(page.url())![1]!)
    await page
      .locator('.md', { hasText: sum(base) })
      .first()
      .waitFor({ timeout: 180_000 })
    await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'hidden', timeout: 180_000 })
    const title = (await page.locator('.thread-head h1').first().textContent()) ?? ''
    sessions.push({ id, title, agent: agent.label })
  })

  test('a session dragged from the list opens beside the open one', async () => {
    expect(sessions.length).toBeGreaterThanOrEqual(2)
    const [first, second] = sessions
    await page.goto(`http://127.0.0.1:${env.port}/#/session/${first!.id}`)
    await page.locator('.thread-head h1').first().waitFor()
    const row = page.locator(`.session-row[href$="/session/${second!.id}"]`)
    const main = page.locator('.split-root')
    const box = (await main.boundingBox())!
    await row.dragTo(main, { targetPosition: { x: box.width - 40, y: box.height / 2 } })
    await expect.poll(() => page.locator('.split-pane').count()).toBe(2)
    const panes = page.locator('.split-pane')
    await expect.poll(() => panes.nth(0).getAttribute('data-session-id')).toBe(first!.id)
    await expect.poll(() => panes.nth(1).getAttribute('data-session-id')).toBe(second!.id)
    // Both transcripts at once.
    const bases = agents.map((_, i) => 1000 * (i + 2))
    await panes
      .nth(0)
      .locator('.md', { hasText: sum(bases[0]!) })
      .first()
      .waitFor()
    await panes
      .nth(1)
      .locator('.md', { hasText: sum(bases[1]!) })
      .first()
      .waitFor()
  })

  test('the row menu opens a third session beside them', async () => {
    const third = sessions[2]
    if (!third) return
    await page.locator(`.session-row[href$="/session/${third.id}"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Open side by side/ }).click()
    await expect.poll(() => page.locator('.split-pane').count()).toBe(3)
    await expect
      .poll(() => page.locator('.split-pane').nth(2).getAttribute('data-session-id'))
      .toBe(third.id)
  })

  test('each pane has its own composer', async () => {
    const pane = page.locator('.split-pane').nth(1)
    const base = 7000
    await pane
      .getByLabel('Message')
      .fill(
        `Without using tools, reply with only the sum of ${base + 111} and ${base + 222}, as digits.`,
      )
    expect(await page.locator('.split-pane').nth(0).getByLabel('Message').inputValue()).toBe('')
    await pane.getByRole('button', { name: 'Send' }).click()
    await pane
      .locator('.md', { hasText: sum(base) })
      .first()
      .waitFor({ timeout: 180_000 })
    await pane.getByRole('button', { name: 'Stop' }).waitFor({ state: 'hidden', timeout: 180_000 })
    // Only that pane's session got the message.
    expect(
      await page
        .locator('.split-pane')
        .nth(0)
        .locator('.md', { hasText: sum(base) })
        .count(),
    ).toBe(0)
    if (process.env.SPLIT_SCREENSHOT) {
      await page.mouse.move(5, 5)
      await page.screenshot({ path: process.env.SPLIT_SCREENSHOT })
    }
  })

  test('closing a pane leaves the others', async () => {
    const count = await page.locator('.split-pane').count()
    await page.locator('.split-pane').last().getByRole('button', { name: 'Close pane' }).click()
    await expect.poll(() => page.locator('.split-pane').count()).toBe(count === 2 ? 1 : count - 1)
  })
})
