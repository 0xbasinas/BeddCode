// Sessions side by side with the real agent CLIs: one session each for Claude Code, Codex and
// Grok, then a session dragged from the list beside the open one, another opened beside them from
// the row's menu, and a message sent in a side pane. Uses provider quota, so it runs only through
// `pnpm test:desktop:real`; SPLIT_SCREENSHOT saves a picture of the three panes.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
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

/** A git repository with one commit and, in the checkout, one uncommitted file. */
function repo(dir: string, files: Record<string, string>, dirty: string) {
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: dir,
      stdio: 'ignore',
    })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  writeFileSync(path.join(dir, dirty), 'changed\n')
}

describe('side tools follow the split pane last used', () => {
  const opened: { id: string; folder: string; label: string }[] = []
  const shot = (name: string) =>
    process.env.SPLIT_SHOTS
      ? page.screenshot({ path: path.join(process.env.SPLIT_SHOTS, name) })
      : Promise.resolve()
  const sidePane = () => page.locator('section.side-pane')
  const rail = (name: string) => page.locator('nav.rail').getByRole('button', { name, exact: true })
  const focusPane = async (index: number) => {
    await page
      .locator('.split-pane')
      .nth(index)
      .locator('.transcript')
      .click({ position: { x: 20, y: 20 } })
    await expect
      .poll(() => page.locator('.split-pane').nth(index).getAttribute('class'))
      .toContain('active')
  }

  test('sessions in two projects: one in a worktree, one in the checkout', async () => {
    const pick = agents.slice(0, 2)
    if (pick.length < 2) return
    const projects = [
      {
        folder: path.join(env.home, 'api-server'),
        files: { 'server.ts': 'export {}\n' },
        dirty: 'routes.ts',
        worktree: true,
      },
      {
        folder: path.join(env.home, 'web-shop'),
        files: { 'index.html': '<h1>shop</h1>\n' },
        dirty: 'cart.ts',
        worktree: false,
      },
    ]
    for (const [i, p] of projects.entries()) {
      repo(p.folder, { 'README.md': `# ${path.basename(p.folder)}\n`, ...p.files }, p.dirty)
      await page.goto(
        `http://127.0.0.1:${env.port}/#/?compose=true&project=${encodeURIComponent(p.folder)}`,
      )
      await page.getByRole('button', { name: 'Agent', exact: true }).click()
      await page.getByText(pick[i]!.label, { exact: true }).last().click()
      const workspace = page.getByRole('button', { name: 'Workspace' })
      await workspace.waitFor({ timeout: 30_000 })
      if (!p.worktree) {
        await workspace.click()
        await page.getByRole('button', { name: /Work in the main checkout/ }).click()
      }
      await expect
        .poll(() => workspace.textContent())
        .toMatch(p.worktree ? /New worktree/ : /main checkout/)
      const base = 9000 + i * 1000
      await page
        .getByLabel('Message')
        .fill(
          `Without using tools, reply with only the sum of ${base + 111} and ${base + 222}, as digits.`,
        )
      await page.getByRole('button', { name: 'Send' }).click()
      await page.waitForURL(/#\/session\//, { timeout: 120_000 })
      await page
        .locator('.md', { hasText: sum(base) })
        .first()
        .waitFor({ timeout: 180_000 })
      await page
        .getByRole('button', { name: 'Stop' })
        .waitFor({ state: 'hidden', timeout: 180_000 })
      opened.push({
        id: decodeURIComponent(/#\/session\/([^/?]+)/.exec(page.url())![1]!),
        folder: p.folder,
        label: p.worktree ? `${path.basename(p.folder)} · worktree` : path.basename(p.folder),
      })
    }
  })

  test('Git, Files and Terminal switch project with the pane last used', async () => {
    if (opened.length < 2) return
    const [a, b] = opened as [(typeof opened)[0], (typeof opened)[0]]
    await page.goto(`http://127.0.0.1:${env.port}/#/session/${a.id}`)
    await page.locator('.thread-head h1').first().waitFor()
    // Start from this session alone, then drag the other project's session beside it.
    if ((await page.locator('.split-pane').count()) > 1) {
      await page
        .locator(`.split-pane[data-session-id="${a.id}"]`)
        .getByRole('button', { name: 'Show alone' })
        .click()
    }
    const main = page.locator('.split-root')
    const box = (await main.boundingBox())!
    await page
      .locator(`.session-row[href$="/session/${b.id}"]`)
      .dragTo(main, { targetPosition: { x: box.width - 30, y: box.height / 2 } })
    await expect.poll(() => page.locator('.split-pane').count()).toBe(2)

    // The dropped session is the one in use: Git opens on its project, the checkout with cart.ts.
    await rail('Git').click()
    await expect
      .poll(() => sidePane().locator('.pane-project').first().textContent())
      .toContain(b.label)
    await sidePane().getByText('cart.ts').first().waitFor({ timeout: 30_000 })
    await page.mouse.move(5, 300)
    await shot('beddcode-split-faint-outline.png')

    // Using the other pane switches Git to its worktree, where cart.ts and routes.ts do not exist.
    await focusPane(0)
    await expect
      .poll(() => sidePane().locator('.pane-project').first().textContent())
      .toContain(a.label)
    await expect.poll(() => sidePane().getByText('cart.ts').count()).toBe(0)
    await page.mouse.move(5, 300)
    await shot('beddcode-split-switch.png')

    // Files follows too.
    await rail('Files').click()
    await expect
      .poll(() => sidePane().locator('.pane-project').first().textContent())
      .toContain(a.label)
    await sidePane().locator('.tree-name', { hasText: 'server.ts' }).first().waitFor()
    await focusPane(1)
    await expect
      .poll(() => sidePane().locator('.pane-project').first().textContent())
      .toContain(b.label)
    await sidePane().locator('.tree-name', { hasText: 'index.html' }).first().waitFor()
    expect(await sidePane().locator('.tree-name', { hasText: 'server.ts' }).count()).toBe(0)

    // Terminals belong to each folder: one started for the worktree is not shown for the checkout.
    await focusPane(0)
    await rail('Terminal').click()
    await expect
      .poll(() => sidePane().locator('.pane-project').first().textContent())
      .toContain(a.label)
    await sidePane().locator('.pane-empty').getByRole('button', { name: 'New terminal' }).click()
    await sidePane().locator('.term-tab').first().waitFor({ timeout: 30_000 })
    expect(await sidePane().textContent()).toContain('.wt')
    await focusPane(1)
    await expect
      .poll(() => sidePane().locator('.pane-project').first().textContent())
      .toContain(b.label)
    await sidePane().getByText('No terminal yet').waitFor()
    await focusPane(0)
    await sidePane().locator('.term-tab').first().waitFor()
    await rail('Terminal').click()
  })
})
