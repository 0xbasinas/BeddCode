import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

// Each run sends one short prompt per selected provider. The expected answer appears only
// in assistant content, so the user's own prompt cannot satisfy the assertion.
for (const provider of [
  { id: 'claude', menu: 'CC Claude Code' },
  { id: 'codex', menu: 'C Codex' },
  { id: 'grok', menu: 'G Grok' },
]) {
  test(
    `${provider.id}: starts a session and returns a response`,
    { tags: [provider.id] },
    async ({ app, browser, screen }) => {
      await app.open('/#/?compose=true')
      await screen.getByRole('button', 'Agent').tap()
      await screen.getByRole('button', provider.menu).tap()
      await screen
        .getByLabel('Message')
        .fill('Without using tools, reply with only the single word PONG.')
      await screen.getByRole('button', 'Send').tap()
      await expect(browser.locator('.md')).toContainText('PONG', { timeout: 120_000 })
      await expect(screen.getByRole('button', 'Stop')).not.toBeVisible({ timeout: 120_000 })
    },
  )
}
