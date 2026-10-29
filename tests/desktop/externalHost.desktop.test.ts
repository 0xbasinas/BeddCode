// The desktop app with a host it did not start: one started separately (a terminal, the background
// host), as `beddcode host install` and the host-only installers set up. The app must use it, never
// start a second one or fight over the port, wait while it is down, and leave it running on quit.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { desktopEnv, type DesktopEnv, freePort, launchDesktop, root } from './launch.ts'

// The bundled host (`pnpm --filter @beddcode/desktop host`), as the host-only release ships it, else
// the server from source.
const bundle = path.join(root, 'apps/desktop/build/host')
const fromBundle = existsSync(path.join(bundle, 'server/main.mjs'))

let env: DesktopEnv
let host: ChildProcess | null = null
let app: ElectronApplication | null = null
let page: Page

function startHost() {
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
        BEDDCODE_FAKE_PROVIDER: 'advanced',
        BEDDCODE_WEB_ROOT: fromBundle ? path.join(bundle, 'web') : path.join(root, 'apps/web/dist'),
        BEDDCODE_TELEMETRY: '0',
      },
      stdio: 'ignore',
    },
  )
  return host
}

async function stopHost() {
  const child = host
  host = null
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await exited
}

async function healthy() {
  try {
    return (await fetch(`http://127.0.0.1:${env.port}/health`)).ok
  } catch {
    return false
  }
}

/** Process ids listening on the port (`ss`, which every Linux has; lsof often is not installed). */
function listeners(): number[] {
  try {
    const out = execFileSync('ss', ['-ltnpH', `sport = :${env.port}`]).toString()
    return [...new Set([...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))]
  } catch {
    return []
  }
}

const daemonStatus = () =>
  page
    .evaluate('window.beddcodeDesktop?.daemon.status()')
    .then((s) => (s as { status?: string } | null)?.status ?? 'none')
    .catch(() => 'unreachable')

async function launch(mode: string) {
  const launched = await launchDesktop(env, false, { BEDDCODE_HOST_MODE: mode })
  app = launched.app
  page = launched.page
}

async function quit() {
  await app?.close().catch(() => undefined)
  app = null
}

beforeAll(async () => {
  env = await desktopEnv()
  if (process.env.BEDDCODE_TEST_PORT) env.port = Number(process.env.BEDDCODE_TEST_PORT)
  else env.port = await freePort()
  expect(await healthy(), `port ${env.port} must be free`).toBe(false)
})

afterAll(async () => {
  await quit()
  await stopHost()
})

describe.skipIf(process.platform !== 'linux')('desktop app with a host started separately', () => {
  test('waits for the host, then uses it without starting its own', async () => {
    await launch('external')
    await page.getByText('Waiting for the BeddCode host').waitFor({ timeout: 30_000 })
    await new Promise((r) => setTimeout(r, 3000))
    expect(listeners(), 'the app started a host of its own').toEqual([])

    const child = startHost()
    await expect.poll(healthy, { timeout: 30_000 }).toBe(true)
    // It connects on its own, within a few seconds.
    await expect.poll(daemonStatus, { timeout: 20_000, interval: 500 }).toBe('attached')
    expect(listeners()).toEqual([child.pid])
    await page.getByText('New session').first().waitFor({ timeout: 30_000 })
  })

  test('runs a session through that host', async () => {
    await page.getByRole('button', { name: 'Skip setup' }).click()
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    await page.getByText('Fake agent', { exact: true }).click()
    await page.getByLabel('Message').fill('Run the external host check')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.getByText('Run the new test?').first().waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Allow Enter' }).click()
    await page.getByText('All tests pass.').first().waitFor({ timeout: 60_000 })
  })

  test('waits while the host is down and reconnects when it is back', async () => {
    await stopHost()
    await expect.poll(daemonStatus, { timeout: 20_000, interval: 500 }).toBe('waiting')
    await new Promise((r) => setTimeout(r, 3000))
    expect(listeners(), 'the app started a host of its own').toEqual([])
    await page
      .getByText(/Waiting for the BeddCode host/)
      .first()
      .waitFor({ timeout: 15_000 })

    const child = startHost()
    await expect.poll(daemonStatus, { timeout: 30_000, interval: 500 }).toBe('attached')
    expect(listeners()).toEqual([child.pid])
    await page.getByText('New session').first().waitFor({ timeout: 30_000 })
  })

  test('leaves the host running when it quits', async () => {
    const pid = host!.pid
    await quit()
    await new Promise((r) => setTimeout(r, 1000))
    expect(await healthy()).toBe(true)
    expect(listeners()).toEqual([pid])
  })

  test('in Automatic mode it uses a host already running instead of starting a second', async () => {
    const pid = host!.pid
    await launch('auto')
    await expect.poll(daemonStatus, { timeout: 30_000, interval: 500 }).toBe('attached')
    await page.getByText('New session').first().waitFor({ timeout: 30_000 })
    expect(listeners()).toEqual([pid])
    await quit()
    expect(await healthy()).toBe(true)
  })
})
