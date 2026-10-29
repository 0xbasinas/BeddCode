// Run against local Wrangler with MCP_PASSWORD=test-client-password and a local Chrome installation.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chromium } from 'playwright-core'

const base = process.env.BEDDCODE_OAUTH_TEST_URL ?? 'http://127.0.0.1:8899'
const redirect = 'http://127.0.0.1:4567/callback'
const registration = await fetch(`${base}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'BeddCode browser test',
    redirect_uris: [redirect],
    token_endpoint_auth_method: 'none',
  }),
})
assert.equal(registration.status, 201)
const { client_id } = await registration.json()
const verifier = randomBytes(32).toString('base64url')
const query = new URLSearchParams({
  response_type: 'code',
  client_id,
  redirect_uri: redirect,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
  state: 'browser-test',
  resource: `${base}/mcp`,
})
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BEDDCODE_TEST_BROWSER
    ? { executablePath: process.env.BEDDCODE_TEST_BROWSER }
    : {}),
})
try {
  const context = await browser.newContext()
  await context.route('http://127.0.0.1:4567/callback**', (route) =>
    route.fulfill({ status: 200, body: 'Callback received' }),
  )
  const page = await context.newPage()
  await page.goto(`${base}/authorize?${query}`)
  await page.locator('#password').fill('test-client-password')
  await page.getByRole('button', { name: 'Allow' }).click()
  await page.waitForURL('http://127.0.0.1:4567/callback**', { timeout: 10000 })
  const callback = new URL(page.url())
  assert.ok(callback.searchParams.get('code'))
  assert.equal(callback.searchParams.get('state'), 'browser-test')
  console.log('Chrome delivered the OAuth code and state to the registered callback.')
} finally {
  await browser.close()
}
