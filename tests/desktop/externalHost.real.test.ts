// Real agent CLIs (Claude Code, Codex, Grok over ACP) through a host the desktop app did not start,
// as with `beddcode host install` or the host-only installers. Uses provider quota, so it runs only
// through `pnpm test:desktop:real`; pick agents with DESKTOP_PROVIDERS=claude,codex,grok.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
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

beforeAll(async () => {
  env = await desktopEnv(true)
  env.port = Number(process.env.BEDDCODE_TEST_PORT) || (await freePort())
  const args = fromBundle
    ? [path.join(bundle, 'server/main.mjs')]
    : ['--import', 'tsx', path.join(root, 'apps/server/src/main.ts')]
  host = spawn(
    process.execPath,
    [...args, 'serve', '--port', String(env.port), '--host', '127.0.0.1'],
    {
      cwd: root,
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
  await page.getByRole('button', { name: 'Skip setup' }).click({ timeout: 90_000 })
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  host?.kill('SIGTERM')
  for (const folder of [env?.home, env?.userData]) {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
})

describe.each(agents)('$name through a host started separately', (agent) => {
  test('a prompt typed in the window gets a response', async () => {
    const status = (await page.evaluate('window.beddcodeDesktop.daemon.status()')) as {
      status: string
    }
    expect(status.status).toBe('attached')
    await page.goto(`http://127.0.0.1:${env.port}/#/?compose=true`)
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    await page.getByText(agent.label, { exact: true }).last().click()
    // The answer is not in the prompt, so only the agent can have written it.
    const base = 1000 * (agents.indexOf(agent) + 2)
    const word = String(base + 111 + (base + 222))
    await page
      .getByLabel('Message')
      .fill(
        `Without using tools, reply with only the sum of ${base + 111} and ${base + 222}, as digits.`,
      )
    await page.getByRole('button', { name: 'Send' }).click()
    await page
      .locator('.md', { hasText: word })
      .first()
      .waitFor({ timeout: 180_000 })
      .catch(async (error) => {
        await page.screenshot({ path: path.join(env.userData, '..', `external-${agent.name}.png`) })
        console.log(await page.evaluate('document.body.innerText'))
        throw error
      })
    await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'hidden', timeout: 180_000 })
  })
})
