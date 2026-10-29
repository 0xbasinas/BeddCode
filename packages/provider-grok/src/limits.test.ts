import { describe, expect, it } from 'vitest'
import { grokUsageToLimits, readGrokLimits, readGrokToken } from './limits.ts'

const KEY = 'https://auth.x.ai::client-id'
const NOW = Date.parse('2026-10-28T12:00:00Z')
const auth = (entry: object) => JSON.stringify({ [KEY]: entry })
const files =
  (map: Record<string, string>) =>
  async (file: string): Promise<string | undefined> =>
    Object.entries(map).find(([name]) => file.replace(/\\/g, '/').endsWith(name))?.[1]
const base = { env: { GROK_HOME: '/h' }, now: () => NOW }

describe('readGrokToken', () => {
  it('reads the token of the account grok login stored', async () => {
    const token = await readGrokToken({
      ...base,
      readText: files({ '/h/auth.json': auth({ key: ' tok ', auth_mode: 'oidc' }) }),
    })
    expect(token).toEqual({ token: 'tok' })
  })

  it('stands aside for an API key, a custom endpoint or a custom sign-in', async () => {
    const readText = files({ '/h/auth.json': auth({ key: 'tok', auth_mode: 'oidc' }) })
    for (const env of [
      { XAI_API_KEY: 'k' },
      { GROK_OAUTH2_ISSUER: 'x' },
      { GROK_MODELS_BASE_URL: 'x' },
      { GROK_AUTH_PROVIDER_COMMAND: 'x' },
    ]) {
      const res = await readGrokToken({ env: { GROK_HOME: '/h', ...env }, readText })
      expect(res.token).toBeUndefined()
      expect(res.note).toMatch(/grok login/)
    }
    const res = await readGrokToken({
      ...base,
      readText: files({
        '/h/auth.json': auth({ key: 'tok', auth_mode: 'oidc' }),
        '/h/config.toml': '[endpoints]\nchat = "https://example.com"\n',
      }),
    })
    expect(res.token).toBeUndefined()
  })

  it('does not use an API-key entry or an expired sign-in', async () => {
    const apiKey = await readGrokToken({
      ...base,
      readText: files({ '/h/auth.json': auth({ key: 'tok', auth_mode: 'api_key' }) }),
    })
    expect(apiKey.token).toBeUndefined()
    const expired = await readGrokToken({
      ...base,
      readText: files({
        '/h/auth.json': auth({ key: 'tok', auth_mode: 'oidc', expires_at: NOW / 1000 - 60 }),
      }),
    })
    expect(expired.token).toBeUndefined()
    expect(expired.note).toMatch(/expired/)
  })

  it('says to sign in when there is nothing stored', async () => {
    expect((await readGrokToken({ ...base, readText: files({}) })).note).toMatch(/grok login/)
    expect(
      (await readGrokToken({ ...base, readText: files({ '/h/auth.json': 'not json' }) })).note,
    ).toMatch(/could not be read/)
  })
})

describe('grokUsageToLimits', () => {
  it('maps the subscription period to one window', () => {
    expect(
      grokUsageToLimits({
        config: {
          creditUsagePercent: 42.5,
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: '2026-10-25T00:00:00Z',
            end: '2026-11-01T00:00:00Z',
          },
        },
      }),
    ).toEqual({
      windows: [
        {
          id: 'subscription',
          label: 'Weekly',
          usedPercent: 42.5,
          resetsAt: Date.parse('2026-11-01T00:00:00Z'),
        },
      ],
    })
  })

  it('reads an omitted percentage as zero when the period is whole', () => {
    const res = grokUsageToLimits({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_MONTHLY',
          start: '2026-10-01T00:00:00Z',
          end: '2026-11-01T00:00:00Z',
        },
      },
    })
    expect(res.windows[0]).toMatchObject({ label: 'Monthly', usedPercent: 0 })
  })

  it('clamps to 0 through 100 and gives a note when there is nothing to show', () => {
    expect(grokUsageToLimits({ config: { creditUsagePercent: 180 } }).windows[0]!.usedPercent).toBe(
      100,
    )
    expect(grokUsageToLimits({}).windows).toEqual([])
    expect(grokUsageToLimits({}).note).toMatch(/did not report/)
  })
})

describe('readGrokLimits', () => {
  const readText = files({ '/h/auth.json': auth({ key: 'tok', auth_mode: 'oidc' }) })
  const reply = (status: number, body: unknown = {}) =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch

  it('sends the stored token and returns the window', async () => {
    let sent: Headers | undefined
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent = new Headers(init.headers)
      return new Response(JSON.stringify({ config: { creditUsagePercent: 10 } }))
    }) as typeof fetch
    const res = await readGrokLimits({ ...base, readText, fetchFn })
    expect(sent!.get('authorization')).toBe('Bearer tok')
    expect(res.windows).toMatchObject([{ usedPercent: 10 }])
  })

  it('never calls out without a usable token', async () => {
    let called = false
    const fetchFn = (async () => {
      called = true
      return new Response('{}')
    }) as typeof fetch
    await readGrokLimits({ env: { GROK_HOME: '/h', XAI_API_KEY: 'k' }, readText, fetchFn })
    expect(called).toBe(false)
  })

  it('turns a refusal or a network failure into a note', async () => {
    expect((await readGrokLimits({ ...base, readText, fetchFn: reply(401) })).note).toMatch(
      /rejected/,
    )
    expect((await readGrokLimits({ ...base, readText, fetchFn: reply(500) })).note).toMatch(
      /right now/,
    )
    const boom = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    expect((await readGrokLimits({ ...base, readText, fetchFn: boom })).note).toMatch(/right now/)
  })
})
