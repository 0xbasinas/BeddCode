import { rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { desktopEnv, launchDesktop, type DesktopEnv } from './launch.ts'
import { Host } from '../shared/hostClient.ts'
import { openSession } from './ui.ts'
import {
  createReviewComment,
  numberPatch,
  reviewPatchVersion,
} from '../../packages/client-runtime/src/reviewComments.ts'

let env: DesktopEnv
let app: ElectronApplication
let page: Page
let host: Host
let sessionId: string
let queuedSessionId: string

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

test('keeps a conflicting notes draft and requires a deliberate replacement', async () => {
  await page.getByRole('button', { name: 'Environment', exact: true }).click()
  const notes = page.getByRole('textbox', { name: 'Session notes', exact: true })
  await notes.fill('Draft from this window')
  await host.rpc('sessions.notes.set', {
    sessionId,
    text: 'Saved from another device',
    expectedVersion: 0,
  })
  await page.getByText('Notes changed on another device. Your draft is preserved.').waitFor()
  expect(await notes.inputValue()).toBe('Draft from this window')
  expect(await page.getByRole('button', { name: 'Save notes', exact: true }).isDisabled()).toBe(
    true,
  )
  await page.getByRole('button', { name: 'Keep my draft for another save', exact: true }).click()
  await page.getByRole('button', { name: 'Save notes', exact: true }).click()
  await expect
    .poll(async () => (await host.rpc('sessions.notes.get', { sessionId })).text)
    .toBe('Draft from this window')
  await page.getByRole('button', { name: 'Environment', exact: true }).click()
})

test('restores an uploaded draft after reload, sends it and exports an extractable archive', async () => {
  const attachment = await host.rpc('attachments.upload', {
    name: 'restored.txt',
    dataBase64: Buffer.from('durable attachment contents').toString('base64'),
  })
  await page.evaluate(
    ({ sessionId, attachment }) => {
      const hostKey = JSON.parse(
        localStorage.getItem('beddcode.composer-drafts') ?? '{"state":{"drafts":{}}}',
      ).state.drafts
      const key = Object.keys(hostKey).find((key) => key.includes(sessionId))
      if (!key) throw new Error('Expected the existing composer draft key')
      localStorage.setItem(
        'beddcode.attachment-drafts.v1',
        JSON.stringify({
          [key]: [{ name: 'restored.txt', size: 26, id: attachment.id, status: 'done' }],
        }),
      )
    },
    { sessionId, attachment },
  )
  await page.reload()
  await openSession(page, { id: sessionId, marker: 'QUALITY-CHECK' })
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Send restored upload')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await host.wait(
    () =>
      host.events.some(
        ({ event }) =>
          event.sessionId === sessionId &&
          event.type === 'message.delta' &&
          event.text === 'Send restored upload' &&
          event.attachments?.[0]?.name === 'restored.txt',
      ),
    30_000,
  )
  const file = path.join(env.home, 'session.tar')
  await app.evaluate(({ BrowserWindow }, file) => {
    BrowserWindow.getAllWindows()[0]!.webContents.session.once(
      'will-download',
      (_event, download) => download.setSavePath(file),
    )
  }, file)
  await page.getByRole('button', { name: 'Session menu' }).click()
  await page.getByRole('button', { name: 'Export with attachments (.tar)' }).click()
  await expect.poll(() => existsSync(file)).toBe(true)
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', file, 'manifest.json'], { encoding: 'utf8', windowsHide: true }),
  )
  expect(manifest.attachments).toContainEqual({
    name: 'restored.txt',
    entry: 'attachments/001-restored.txt',
    included: true,
  })
  expect(
    execFileSync('tar', ['-xOf', file, 'attachments/001-restored.txt'], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  ).toBe('durable attachment contents')
})

test('keeps stale review comments accessible after the file becomes clean', async () => {
  const cwd = path.join(env.home, 'review-project')
  mkdirSync(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Regression')
  git('config', 'user.email', 'regression@example.test')
  writeFileSync(path.join(cwd, 'review.txt'), 'original\n')
  git('add', '.')
  git('commit', '-qm', 'Initial')
  const { sessionId: reviewSession } = await host.rpc('sessions.create', {
    instanceId: 'fake',
    cwd,
    permissionMode: 'acceptEdits',
  })
  await host.rpc('sessions.prompt', { sessionId: reviewSession, text: 'REVIEW-CHECK' })
  await host.wait(() =>
    host.events.some(
      ({ event }) => event.sessionId === reviewSession && event.type === 'turn.completed',
    ),
  )
  await host.rpc('files.write', { cwd, path: 'review.txt', content: 'reviewed version\n' })
  const { patch } = await host.rpc('git.diff', { cwd, path: 'review.txt' })
  const lines = numberPatch(patch)
  const comment = createReviewComment({
    path: 'review.txt',
    lines,
    index: lines.findIndex((line) => line.kind === 'add'),
    body: 'Check this captured version',
    id: 'stale-regression',
  })!
  await page.evaluate(
    ({ cwd, comment, patchVersion }) => {
      const hostKey = 'local'
      localStorage.setItem(
        'beddcode.review-comments',
        JSON.stringify({ [JSON.stringify([hostKey, cwd])]: [{ ...comment, patchVersion }] }),
      )
    },
    { cwd, comment, patchVersion: reviewPatchVersion(patch), sessionId },
  )
  await host.rpc('files.write', { cwd, path: 'review.txt', content: 'original\n' })
  await page.reload()
  await openSession(page, { id: reviewSession, marker: 'REVIEW-CHECK' })
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await page.getByRole('button', { name: 'Send to agent', exact: true }).click()
  await page
    .getByText('Some review comments refer to a changed or unavailable diff.', { exact: false })
    .waitFor()
  const review = page.getByRole('region', { name: 'Comments needing review' })
  await review.locator('summary').click()
  await review
    .getByRole('textbox', { name: 'Edit review comment for review.txt:1' })
    .fill('Updated stale comment')
  expect(await review.locator('pre').innerText()).toContain('reviewed version')
  await review.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Send to agent', exact: true }).click()
  await host.wait(() =>
    host.events.some(
      ({ event }) =>
        event.sessionId === reviewSession &&
        event.type === 'message.delta' &&
        event.text?.includes('Updated stale comment'),
    ),
  )
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.locator('button.tree-row.file[title="review.txt"]').click()
  const editor = page.locator('.cm-content[contenteditable="true"]')
  await editor.fill('My unsaved draft')
  await host.rpc('files.write', { cwd, path: 'review.txt', content: 'External update one\n' })
  await page
    .getByText('This file changed on disk and you have unsaved edits.', { exact: true })
    .waitFor()
  await page.getByRole('button', { name: 'Compare with disk', exact: true }).click()
  await page
    .getByLabel('Current disk contents')
    .filter({ hasText: 'External update one' })
    .waitFor()
  await host.rpc('files.write', { cwd, path: 'review.txt', content: 'External update two\n' })
  await page.getByRole('button', { name: 'Replace compared version', exact: true }).click()
  await page.getByRole('button', { name: 'Save my draft', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'changed on disk' }).waitFor()
  expect(await editor.innerText()).toContain('My unsaved draft')
  expect((await host.rpc('files.read', { cwd, path: 'review.txt' })).content).toBe(
    'External update two\n',
  )
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await page.getByRole('textbox', { name: 'Save draft copy as', exact: true }).fill('recovered.txt')
  await page.getByRole('button', { name: 'Save new copy', exact: true }).click()
  await expect
    .poll(async () => (await host.rpc('files.read', { cwd, path: 'recovered.txt' })).content)
    .toBe('My unsaved draft')
  await openSession(page, { id: sessionId, marker: 'QUALITY-CHECK' })
})

test('prepares selected CI logs without sending and warns when the PR head moves', async () => {
  const cwd = path.join(env.home, 'review-project')
  const reviewSession = host.events.find(
    ({ event }) => event.type === 'session.created' && event.cwd === cwd,
  )!.event.sessionId
  await openSession(page, { id: reviewSession, marker: 'REVIEW-CHECK' })
  if (
    (await page.getByRole('button', { name: 'Git', exact: true }).getAttribute('aria-pressed')) !==
    'true'
  )
    await page.getByRole('button', { name: 'Git', exact: true }).click()
  await page.getByRole('tab', { name: 'PR', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep my CI draft')
  const before = host.events.filter(
    ({ event }) =>
      event.sessionId === reviewSession && event.type === 'message.delta' && event.role === 'user',
  ).length
  await page.evaluate(() => {
    const send = WebSocket.prototype.send
    let verified = 0
    WebSocket.prototype.send = function (data) {
      const frame = typeof data === 'string' ? JSON.parse(data) : null
      let result: unknown
      if (frame?.method === 'git.ci.report')
        result = {
          pr: {
            number: 1,
            title: 'CI regression',
            url: 'https://example.test/pr/1',
            headOid: 'captured-head',
          },
          branch: 'main',
          runs: [
            {
              id: 55,
              workflow: 'CI',
              title: 'Regression',
              status: 'completed',
              conclusion: 'failure',
              sha: 'captured-head',
              url: 'https://example.test/run/55',
            },
          ],
          failures: [
            {
              checks: ['Failed build'],
              url: 'https://example.test/run/55',
              log: 'build failure excerpt',
            },
            { checks: ['Failed lint'], url: 'https://example.test/run/56' },
          ],
        }
      if (frame?.method === 'git.pr.view') {
        result = {
          headOid: 'new-head',
          number: 1,
          title: 'CI regression',
          url: 'https://example.test/pr/1',
          state: 'OPEN',
          isDraft: false,
          body: '',
          headBranch: 'main',
          baseBranch: 'main',
          checks: [],
          files: [],
          author: 'Regression',
          timeline: [],
        }
        if (++verified === 2) WebSocket.prototype.send = send
      }
      if (result) {
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ t: 'res', id: frame.id, ok: true, result }),
          }),
        )
        return
      }
      return send.call(this, data)
    }
  })
  await page.getByRole('button', { name: 'Prepare CI follow-up', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Failed lint', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Add to message draft', exact: true }).click()
  await page
    .getByText('PR head changed from captured-head to new-head.', { exact: false })
    .waitFor()
  expect(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue()).toBe(
    'Keep my CI draft',
  )
  await page
    .getByRole('checkbox', {
      name: 'Keep captured logs despite stale or unverified PR head',
      exact: true,
    })
    .check()
  await page.getByRole('button', { name: 'Add to message draft', exact: true }).click()
  await expect
    .poll(async () => page.getByRole('textbox', { name: 'Message', exact: true }).inputValue())
    .toContain('build failure excerpt')
  const prepared = await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue()
  expect(prepared).toContain('Keep my CI draft')
  expect(prepared).toContain('captured-head')
  expect(prepared).not.toContain('Failed lint')
  expect(
    host.events.filter(
      ({ event }) =>
        event.sessionId === reviewSession &&
        event.type === 'message.delta' &&
        event.role === 'user',
    ),
  ).toHaveLength(before)
  await openSession(page, { id: sessionId, marker: 'QUALITY-CHECK' })
})

test('edits and reorders queued follow-ups without steering the running turn', async () => {
  ;({ sessionId: queuedSessionId } = await host.rpc('sessions.create', {
    instanceId: 'fake',
    projectless: true,
    permissionMode: 'acceptEdits',
  }))
  await host.rpc('sessions.prompt', { sessionId: queuedSessionId, text: 'QUEUE-CHECK [hold]' })
  await openSession(page, { id: queuedSessionId, marker: 'QUEUE-CHECK' })
  for (const text of ['first follow-up', 'second follow-up']) {
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page
      .getByRole('list', { name: 'Queued messages' })
      .getByText(text, { exact: true })
      .waitFor()
  }
  const queue = page.getByRole('list', { name: 'Queued messages' })
  await queue.getByRole('button', { name: 'Edit', exact: true }).first().click()
  await queue.getByRole('textbox', { name: 'Edit queued message' }).fill('edited first follow-up')
  await queue.getByRole('button', { name: 'Save queued message', exact: true }).click()
  await queue.getByRole('button', { name: 'Move queued message 2 up' }).click()
  await expect
    .poll(async () => queue.locator('.queue-text').allTextContents())
    .toEqual(['second follow-up', 'edited first follow-up'])
  expect(
    host.events.filter(
      ({ event }) =>
        event.sessionId === queuedSessionId &&
        event.type === 'message.delta' &&
        event.role === 'user',
    ),
  ).toHaveLength(1)
  await openSession(page, { id: sessionId, marker: 'QUALITY-CHECK' })
})

test('preserves host notes and upload IDs after a host restart and reports a lost terminal', async () => {
  const attachment = await host.rpc('attachments.upload', {
    name: 'restart.txt',
    dataBase64: 'cmVzdGFydA==',
  })
  if (
    !(
      (await page
        .getByRole('button', { name: 'Terminal', exact: true })
        .getAttribute('aria-pressed')) === 'true'
    )
  )
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.getByRole('button', { name: 'New terminal', exact: true }).first().click()
  const cwd = host.events.find(
    ({ event }) => event.type === 'session.created' && event.sessionId === sessionId,
  )!.event.cwd
  let terminalId = ''
  await expect
    .poll(async () => {
      terminalId =
        (await host.rpc('terminals.list', { cwd })).find(
          (terminal: { agent?: unknown; exited?: number }) =>
            !terminal.agent && terminal.exited === undefined,
        )?.id ?? ''
      return terminalId
    })
    .not.toBe('')
  await expect
    .poll(async () =>
      page.evaluate(
        (key) => localStorage.getItem(key),
        `beddcode.active-terminal:${JSON.stringify(['local', cwd])}`,
      ),
    )
    .toBe(terminalId)
  host.close()
  await app.close()
  ;({ app, page } = await launchDesktop(env))
  await page.getByRole('button', { name: 'Hosts', exact: true }).waitFor({ timeout: 90_000 })
  host = new Host(`ws://127.0.0.1:${env.port}/ws`)
  await host.connect()
  expect(await host.rpc('sessions.notes.get', { sessionId })).toMatchObject({
    text: 'Draft from this window',
    version: 2,
  })
  expect(await host.rpc('attachments.inspect', { ids: [attachment.id] })).toMatchObject([
    { id: attachment.id, name: 'restart.txt' },
  ])
  expect(await host.rpc('attachments.read', { id: attachment.id })).toMatchObject({
    dataBase64: 'cmVzdGFydA==',
  })
  await openSession(page, { id: sessionId, marker: 'QUALITY-CHECK' })
  if (
    (await page
      .getByRole('button', { name: 'Terminal', exact: true })
      .getAttribute('aria-pressed')) !== 'true'
  )
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page
    .getByText('The previously selected terminal is no longer available on this host.', {
      exact: false,
    })
    .waitFor({ timeout: 10_000 })
    .catch(async (err) => {
      throw new Error(
        `${String(err)}\nTerminal diagnostics: ${JSON.stringify({
          remembered: await page.evaluate(
            (key) => localStorage.getItem(key),
            `beddcode.active-terminal:${JSON.stringify(['local', cwd])}`,
          ),
          text: await page.locator('.side-pane').allTextContents(),
          terminals: (await host.rpc('terminals.list', { cwd })).map(
            (terminal: { id: string; name?: string; agent?: unknown }) => ({
              id: terminal.id,
              name: terminal.name,
              agent: !!terminal.agent,
            }),
          ),
        })}`,
      )
    })
  await openSession(page, { id: queuedSessionId, marker: 'QUEUE-CHECK' })
  await expect
    .poll(async () => page.locator('.queue-text').allTextContents())
    .toEqual(['second follow-up', 'edited first follow-up'])
})
