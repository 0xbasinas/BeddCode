// Run against a local Wrangler instance configured with MCP_PASSWORD=test-client-password.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

const base = process.env.BEDDCODE_OAUTH_TEST_URL ?? 'http://127.0.0.1:8899'
const redirect = 'http://127.0.0.1:4567/callback'
const resource = `${base}/mcp`
const incomplete = await fetch(`${base}/authorize`)
assert.equal(incomplete.status, 400)
assert.match(await incomplete.text(), /missing a client ID/i)
const post = (url, body, headers = {}) =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  })

const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()
assert.equal(metadata.issuer, base)
assert.equal(metadata.registration_endpoint, `${base}/oauth/register`)
const challenge = await fetch(`${base}/mcp`, { method: 'POST' })
assert.equal(challenge.status, 401)
assert.match(challenge.headers.get('www-authenticate'), /resource_metadata/)

const registration = await fetch(`${base}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'BeddCode test',
    redirect_uris: [redirect],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }),
})
assert.equal(registration.status, 201)
const { client_id } = await registration.json()
const verifier = randomBytes(32).toString('base64url')
const code_challenge = createHash('sha256').update(verifier).digest('base64url')
const query = new URLSearchParams({
  response_type: 'code',
  client_id,
  redirect_uri: redirect,
  code_challenge,
  code_challenge_method: 'S256',
  state: 'test',
  resource,
})
const consent = await fetch(`${base}/authorize?${query}`)
assert.equal(consent.status, 200)
const cookie = consent.headers.get('set-cookie')?.split(';')[0]
const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1]
assert.ok(cookie && handle)
const approved = await post(
  '/authorize',
  { handle, password: 'test-client-password', decision: 'approve' },
  { origin: base, cookie },
)
assert.equal(approved.status, 302)
const callback = new URL(approved.headers.get('location'))
assert.equal(callback.searchParams.get('state'), 'test')
const code = callback.searchParams.get('code')
assert.ok(code)
const tokenParams = {
  grant_type: 'authorization_code',
  code,
  client_id,
  redirect_uri: redirect,
  resource,
}
const wrongVerifier = await post('/oauth/token', { ...tokenParams, code_verifier: 'wrong' })
assert.equal(wrongVerifier.status, 400)
// A fresh authorization is required after a failed exchange: providers may consume the code.
const secondConsent = await fetch(`${base}/authorize?${query}`)
const secondCookie = secondConsent.headers.get('set-cookie')?.split(';')[0]
const secondHandle = (await secondConsent.text()).match(/name="handle" value="([^"]+)"/)?.[1]
assert.ok(secondCookie && secondHandle)
const secondApproval = await post(
  '/authorize',
  { handle: secondHandle, password: 'test-client-password', decision: 'approve' },
  { origin: base, cookie: secondCookie },
)
const secondCode = new URL(secondApproval.headers.get('location')).searchParams.get('code')
assert.ok(secondCode)
const exchange = await post('/oauth/token', {
  ...tokenParams,
  code: secondCode,
  code_verifier: verifier,
})
assert.equal(exchange.status, 200)
const token = await exchange.json()
assert.ok(token.access_token)
const tools = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
})
assert.equal(tools.status, 200)
assert.ok((await tools.json()).result.tools.some((tool) => tool.name === 'list_projects'))
const replay = await post('/oauth/token', {
  ...tokenParams,
  code: secondCode,
  code_verifier: verifier,
})
assert.equal(replay.status, 400)
console.log(
  'OAuth discovery, registration, consent, PKCE, code replay protection and MCP access passed.',
)
