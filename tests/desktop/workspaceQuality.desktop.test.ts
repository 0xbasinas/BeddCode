import { rmSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { desktopEnv, launchDesktop, type DesktopEnv } from './launch.ts'
import { Host } from '../shared/hostClient.ts'
import { openSession } from './ui.ts'

let env: DesktopEnv
let app: ElectronApplication
let page: Page
let host: Host
let sessionId: string

beforeAll(async () => {
  env = await desktopEnv()
  ;({ app, page } = await launchDesktop(env))
  await page.getByRole('heading', { name: 'Welcome to BeddCode' }).waitFor({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Skip setup' }).click()
  host = new Host(`ws://127.0.0.1:${env.port}/ws`)
  await host.connect()
  ;({ sessionId } = await host.rpc('sessions.create', {
    instanceId: 'fake',
    permissionMode: 'acceptEdits',
    projectless: true,
    title: 'Workspace checks',
  }))
  await host.rpc('sessions.prompt', { sessionId, text: 'QUALITY-CHECK' })
  await host.wait(
    () =>
      host.events.some(
        ({ event }) => event.sessionId === sessionId && event.type === 'turn.completed',
      ),
    30_000,
  )
  await openSession(page, { id: sessionId, marker: 'QUALITY-CHECK' })
})

afterAll(async () => {
  host?.close()
  await app?.close()
  if (env) {
    rmSync(env.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(env.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('quotes selected reply text into the existing draft and exports the transcript', async () => {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft')
  await page
    .locator('.transcript .md')
    .last()
    .evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
  await page.getByRole('button', { name: 'Quote in reply', exact: true }).click()
  expect(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue()).toMatch(
    /^Keep this draft\n\nRegarding the agent's reply/,
  )
  await page.getByRole('button', { name: 'Session menu' }).click()
  const file = path.join(env.home, 'export.md')
  await app.evaluate(({ BrowserWindow }, file) => {
    BrowserWindow.getAllWindows()[0]!.webContents.session.once(
      'will-download',
      (_event, download) => download.setSavePath(file),
    )
  }, file)
  await page.getByRole('button', { name: 'Export transcript (.md)' }).click()
  await expect.poll(() => existsSync(file)).toBe(true)
  expect(readFileSync(file, 'utf8')).toContain('QUALITY-CHECK')
})

test('keeps a terminal visible after a failed close and allows retry', async () => {
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.getByRole('button', { name: 'New terminal', exact: true }).first().click()
  await expect
    .poll(
      async () =>
        (
          await host.rpc('terminals.list', {
            cwd: host.events.find(
              ({ event }) => event.type === 'session.created' && event.sessionId === sessionId,
            )!.event.cwd,
          })
        ).length,
    )
    .toBeGreaterThan(0)
  await page.evaluate(() => {
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function (data) {
      const frame = typeof data === 'string' ? JSON.parse(data) : null
      if (frame?.method === 'terminals.close') {
        WebSocket.prototype.send = send
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              t: 'res',
              id: frame.id,
              ok: false,
              error: 'Simulated close failure',
            }),
          }),
        )
        return
      }
      return send.call(this, data)
    }
  })
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click()
  await page.getByRole('button', { name: 'Close terminal', exact: true }).last().click()
  await page.getByText(/Could not close.*Simulated close failure/).waitFor()
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click()
  await page.getByRole('button', { name: 'Close terminal', exact: true }).last().click()
  await page.getByText('Simulated close failure', { exact: false }).waitFor({ state: 'hidden' })
})

test('keeps the visible message anchored when content above it grows', async () => {
  const shift = await page.locator('.transcript').evaluate(async (scroller) => {
    const content = scroller.querySelector('.transcript-inner')!
    const above = document.createElement('div')
    const below = document.createElement('div')
    above.style.height = '1000px'
    below.style.height = '2000px'
    content.prepend(above)
    content.append(below)
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    await frame()
    await frame()
    const message = scroller.querySelector<HTMLElement>('[data-msg-id]')!
    scroller.scrollTop +=
      message.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 20
    scroller.dispatchEvent(new Event('scroll'))
    await frame()
    const before = message.getBoundingClientRect().top
    above.style.height = '1300px'
    await frame()
    await frame()
    const delta = Math.abs(message.getBoundingClientRect().top - before)
    above.remove()
    below.remove()
    return delta
  })
  expect(shift).toBeLessThan(2)
})

test('revokes a paired device through the native Hosts modal', async () => {
  const { code } = await host.rpc('host.pair', {})
  const response = await fetch(`http://127.0.0.1:${env.port}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'Regression phone' }),
  })
  expect(response.ok).toBe(true)
  await page.getByRole('button', { name: 'Hosts', exact: true }).click()
  await page.getByRole('button', { name: 'Manage hosts', exact: true }).click()
  await page.getByRole('button', { name: 'Share this PC', exact: true }).click()
  await page.getByRole('button', { name: 'Revoke Regression phone', exact: true }).click()
  await page.getByRole('button', { name: 'Revoke', exact: true }).click()
  await expect
    .poll(async () =>
      (await host.rpc('devices.list', {})).some(
        (d: { name: string }) => d.name === 'Regression phone',
      ),
    )
    .toBe(false)
  await page.getByRole('button', { name: 'Close hosts', exact: true }).click()
})
