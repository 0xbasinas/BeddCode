import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

test('first launch opens the setup wizard', async ({ app, screen }) => {
  await app.open('/')
  await expect(screen.getByRole('heading', 'Welcome to BeddCode')).toBeVisible()
  await expect(screen.getByRole('button', 'Get started')).toBeVisible()
})

test('setup discovers the local host and fake agent', async ({ app, screen }) => {
  await app.open('/')
  await screen.getByRole('button', 'Get started').tap()
  await expect(screen.getByRole('heading', 'Connect this computer')).toBeVisible()
  await expect(screen.getByText('Fake agent')).toBeVisible({ timeout: 30000 })
})

test('skipping setup opens the composer', async ({ app, screen }) => {
  await app.open('/')
  await screen.getByRole('button', 'Skip setup').tap()
  await expect(screen.getByRole('heading', 'New session')).toBeVisible()
  await expect(screen.getByLabel('Message')).toBeVisible()
})

test('settings opens from the workspace', async ({ app, screen }) => {
  await app.open('/')
  await screen.getByRole('button', 'Settings').tap()
  await expect(screen.getByRole('navigation', 'Settings')).toBeVisible()
})

test('a fake session streams and handles approval', async ({ app, screen }) => {
  await app.open('/')
  await screen.getByRole('button', 'Skip setup').tap()
  await screen.getByRole('button', 'Agent').tap()
  await screen.getByRole('button', 'FA Fake agent').tap()
  await screen.getByLabel('Message').fill('Check the sample project')
  await screen.getByRole('button', 'Send').tap()
  await expect(screen.getByText('Run the new test?')).toBeVisible({ timeout: 30000 })
  await screen.getByRole('button', 'Allow Enter').tap()
  await expect(screen.getByText('All tests pass.')).toBeVisible({ timeout: 30000 })
})

test('denying an approval stops the requested command', async ({ app, screen }) => {
  await app.open('/#/?compose=true')
  await screen.getByRole('button', 'Agent').tap()
  await screen.getByRole('button', 'FA Fake agent').tap()
  await screen.getByLabel('Message').fill('Check approval denial')
  await screen.getByRole('button', 'Send').tap()
  await expect(screen.getByText('Run the new test?')).toBeVisible({ timeout: 30000 })
  await screen.getByRole('button', 'Deny Esc').tap()
  await expect(screen.getByText('Understood, I will not run the test.')).toBeVisible({
    timeout: 30000,
  })
})

test('an agent question can be answered and the turn continues', async ({ app, screen }) => {
  await app.open('/#/?compose=true')
  await screen.getByRole('button', 'Agent').tap()
  await screen.getByRole('button', 'FA Fake agent').tap()
  await screen.getByLabel('Message').fill('[question] Choose a database')
  await screen.getByRole('button', 'Send').tap()
  await expect(screen.getByText('Which database?')).toBeVisible({ timeout: 30000 })
  await screen.getByRole('radio', 'SQLite').tap()
  await screen.getByRole('button', 'Send answer').tap()
  await expect(screen.getByText('Run the new test?')).toBeVisible({ timeout: 30000 })
  await screen.getByRole('button', 'Allow Enter').tap()
  await expect(screen.getByText('All tests pass.')).toBeVisible({ timeout: 30000 })
})

test('a completed session survives a page reload', async ({ app, browser, screen }) => {
  await app.open('/#/?compose=true')
  await screen.getByRole('button', 'Agent').tap()
  await screen.getByRole('button', 'FA Fake agent').tap()
  await screen.getByLabel('Message').fill('Check reload recovery')
  await screen.getByRole('button', 'Send').tap()
  await expect(screen.getByText('Run the new test?')).toBeVisible({ timeout: 30000 })
  await screen.getByRole('button', 'Allow Enter').tap()
  await expect(screen.getByText('All tests pass.')).toBeVisible({ timeout: 30000 })
  await browser.reload()
  await expect(screen.getByText('All tests pass.')).toBeVisible({ timeout: 30000 })
  await expect(screen.getByRole('heading', 'Check reload recovery')).toBeVisible()
})

test('a running session can be stopped', async ({ app, screen }) => {
  await app.open('/#/?compose=true')
  await screen.getByRole('button', 'Agent').tap()
  await screen.getByRole('button', 'FA Fake agent').tap()
  await screen.getByLabel('Message').fill('[slow] Check cancellation')
  await screen.getByRole('button', 'Send').tap()
  await screen.getByRole('button', 'Stop').tap()
  await expect(screen.getByRole('button', 'Send')).toBeVisible({ timeout: 30000 })
})

test('an unsent draft survives navigating to settings and back', async ({
  app,
  browser,
  screen,
}) => {
  await app.open('/#/?compose=true')
  await screen.getByLabel('Message').fill('Keep this unfinished message')
  await screen.getByRole('button', 'Settings').tap()
  await expect(screen.getByRole('navigation', 'Settings')).toBeVisible()
  await browser.back()
  await expect(screen.getByLabel('Message')).toHaveValue('Keep this unfinished message')
})
