import {
  AuthorizationError,
  CimdFetchError,
  OAuthAuthorizationServer,
} from '@cloudflare/workers-oauth-provider'

export interface OAuthEnv {
  OAUTH_KV: KVNamespace
  MCP_PASSWORD?: string
}

/** The authorization server issues tokens only for this Worker's MCP resource. */
export function authorizationServer(origin: string) {
  return new OAuthAuthorizationServer<OAuthEnv>({
    issuer: origin,
    resources: [`${origin}/mcp`],
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ['mcp:access'],
    accessTokenTTL: 3600,
    refreshTokenTTL: 2592000,
  })
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )

/** Render only library-validated client details and a browser-bound consent handle. */
export async function authorize(
  request: Request,
  env: OAuthEnv,
  server: OAuthAuthorizationServer<OAuthEnv>,
  checkPassword: (value: string) => Promise<boolean>,
  rejectPassword: () => Promise<void>,
): Promise<Response> {
  const oauth = server.getOAuthApi(env)
  try {
    if (request.method === 'GET') {
      const auth = await oauth.parseAuthRequest(request)
      const details = await oauth.describeConsent(auth)
      const consent = await oauth.beginConsent(auth)
      consent.headers.set('content-type', 'text/html; charset=utf-8')
      consent.headers.set('cache-control', 'no-store')
      consent.headers.set(
        'content-security-policy',
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(details.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`,
      )
      const client = escape(details.clientName)
      const domain = details.clientDomain
        ? `Published by ${escape(details.clientDomain)}.`
        : 'This client name is self-reported.'
      const target = escape(details.redirectHost)
      const scopes = details.scope.length
        ? details.scope.map(escape).join(', ')
        : 'Full BeddCode MCP access'
      const local = details.redirectIsLoopback
        ? '<p>Access will be sent to an app on your computer. Continue only if you started this connection.</p>'
        : ''
      const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect to BeddCode</title><style>body{font:16px system-ui;background:#111;color:#eee;max-width:34rem;margin:8vh auto;padding:1.5rem}input,button{font:inherit;padding:.7rem;border-radius:.4rem}input{width:90%}button{margin:.7rem .5rem 0 0}p{line-height:1.5}</style><h1>Connect to BeddCode</h1><p><strong>${client}</strong> wants to control agents and access your added projects. ${domain}</p><p>Authorization returns to <strong>${target}</strong>. Requested access: ${scopes}.</p>${local}<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}"><label for="password">MCP password</label><p><input id="password" type="password" name="password" required autocomplete="current-password"></p><button name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></form>`
      return new Response(html, { headers: consent.headers })
    }
    if (request.method !== 'POST')
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return new Response('Invalid origin', { status: 403 })
    if (Number(request.headers.get('content-length') ?? 0) > 16384)
      return new Response('Too large', { status: 413 })
    const form = await request.formData()
    const handle = String(form.get('handle') ?? '')
    if (form.get('decision') === 'deny') {
      const denied = await oauth.denyConsent(request, handle)
      return new Response(null, { status: 302, headers: denied.headers })
    }
    if (form.get('decision') !== 'approve') return new Response('Invalid decision', { status: 400 })
    const password = String(form.get('password') ?? '')
    if (!password || password.length > 1024 || !(await checkPassword(password))) {
      await rejectPassword()
      return new Response('Incorrect password. Return to the client and try again.', {
        status: 401,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    const approved = await oauth.approveConsent(request, handle)
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: 'owner',
      metadata: {},
      scope: approved.request.scope,
      props: {},
    })
    approved.headers.set('Location', redirectTo)
    approved.headers.set('cache-control', 'no-store')
    return new Response(null, { status: 302, headers: approved.headers })
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo)
      return Response.redirect(error.redirectTo, 302)
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      // Only expose fixed, known messages: other descriptions can contain client-supplied values.
      const details: Record<string, string> = {
        'client_id is required':
          'The request is missing a client ID. Start sign-in from the MCP client instead of opening the authorization URL directly.',
        'Invalid client_id':
          'The client ID is not registered. Use a client that registers automatically, or register it with its exact callback URL.',
        'Invalid redirect URI':
          'The callback URL does not match the client registration. Check the MCP client settings and register the exact callback URL.',
        'response_type is required':
          'The authorization request is missing its response type. Start sign-in from the MCP client.',
        'Public clients must use PKCE with the authorization code flow.':
          'This client must use PKCE with the S256 method.',
        'This authorization expired or was already used; start again':
          'This sign-in request expired or was already used. Start a new connection from the MCP client.',
        'This authorization was not started in this browser; start again':
          'This sign-in was started in a different browser. Start again and complete it in the same browser.',
        'This authorization belongs to a different browser session; start again':
          'This sign-in belongs to a different browser session. Start again and complete it in the same browser.',
      }
      const message =
        error instanceof CimdFetchError
          ? 'The client metadata could not be verified. Check the client ID and try again.'
          : (details[error.description] ??
            'The authorization request could not be validated. Check the client registration and start again.')
      return new Response(`Authorization failed. ${message}`, {
        status: 400,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff',
        },
      })
    }
    throw error
  }
}
