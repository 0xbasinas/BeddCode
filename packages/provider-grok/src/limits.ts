import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { UsageWindow } from '@beddcode/contracts'

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const TIMEOUT_MS = 10_000

export interface GrokLimits {
  windows: UsageWindow[]
  note?: string
}

export interface GrokLimitsDeps {
  env?: NodeJS.ProcessEnv
  fetchFn?: typeof fetch
  readText?: (file: string) => Promise<string | undefined>
  now?: () => number
}

/** Settings that point Grok at some other account or endpoint than the one signed in with `grok login`. */
const OVERRIDES = [
  'XAI_API_KEY',
  'GROK_AUTH_PROVIDER_COMMAND',
  'GROK_MODELS_BASE_URL',
  'GROK_CONFIG',
]
const OVERRIDE_PREFIX = 'GROK_OAUTH2_'
/** Config sections that change how or where Grok signs in. */
const AUTH_SECTIONS = /^\s*\[(auth|grok_com_config|endpoints)[\].]/m
const CONFIG_FILES = ['config.toml', 'managed_config.toml', 'requirements.toml']

const NOT_AVAILABLE =
  'Plan limits are shown for Grok accounts signed in with `grok login`, not API keys or custom setups.'

const readIfThere = async (file: string) => readFile(file, 'utf8').catch(() => undefined)

/**
 * The token of the account `grok login` stored, or why there is none to use. Only that account is
 * ever read: an API key or a custom sign-in means the plan limits are not this account's to show.
 */
export async function readGrokToken(
  deps: GrokLimitsDeps = {},
): Promise<{ token?: string; note?: string }> {
  const env = deps.env ?? process.env
  const read = deps.readText ?? readIfThere
  if (
    OVERRIDES.some((name) => env[name]?.trim()) ||
    Object.keys(env).some((name) => name.startsWith(OVERRIDE_PREFIX) && env[name]?.trim())
  ) {
    return { note: NOT_AVAILABLE }
  }
  const home = env.GROK_HOME?.trim() || path.join(os.homedir(), '.grok')
  for (const dir of [home, '/etc/grok']) {
    for (const name of CONFIG_FILES) {
      const text = await read(path.join(dir, name))
      if (text && AUTH_SECTIONS.test(text)) return { note: NOT_AVAILABLE }
    }
  }
  const text = await read(env.GROK_AUTH?.trim() || path.join(home, 'auth.json'))
  if (!text) return { note: 'Sign in with `grok login` to see plan limits.' }
  let accounts: unknown
  try {
    accounts = JSON.parse(text)
  } catch {
    return { note: 'Grok’s stored sign-in could not be read.' }
  }
  if (typeof accounts !== 'object' || accounts === null) return { note: NOT_AVAILABLE }
  const now = (deps.now ?? Date.now)()
  for (const [key, entry] of Object.entries(accounts)) {
    if (key !== 'https://accounts.x.ai/sign-in' && !key.startsWith('https://auth.x.ai::')) continue
    const account = entry as { key?: unknown; auth_mode?: unknown; expires_at?: unknown }
    if (typeof account?.key !== 'string' || !account.key.trim()) continue
    if (String(account.auth_mode).toLowerCase() === 'api_key') continue
    const expires = typeof account.expires_at === 'number' ? account.expires_at : NaN
    // Seconds or milliseconds: both are far apart from any date near now.
    const expiresMs = expires < 1e12 ? expires * 1000 : expires
    if (Number.isFinite(expiresMs) && expiresMs < now) {
      return { note: 'Grok’s sign-in has expired. Run `grok login` again to see plan limits.' }
    }
    return { token: account.key.trim() }
  }
  return { note: NOT_AVAILABLE }
}

interface BillingResponse {
  config?: {
    creditUsagePercent?: number
    currentPeriod?: { type?: string; start?: unknown; end?: string }
  }
}

/** The subscription window from Grok's billing answer. A zero is left out of it, so it is inferred. */
export function grokUsageToLimits(body: BillingResponse): GrokLimits {
  const period = body.config?.currentPeriod
  const kind = (period?.type ?? '').replace(/^USAGE_PERIOD_TYPE_/, '').toUpperCase()
  const label = kind === 'WEEKLY' ? 'Weekly' : kind === 'MONTHLY' ? 'Monthly' : 'Subscription'
  const end = period?.end ? Date.parse(period.end) : NaN
  const start = typeof period?.start === 'string' ? Date.parse(period.start) : NaN
  let used = body.config?.creditUsagePercent
  if (typeof used !== 'number' && (kind === 'WEEKLY' || kind === 'MONTHLY') && start < end) used = 0
  if (typeof used !== 'number' || !Number.isFinite(used)) {
    return { windows: [], note: 'Grok did not report how much of the plan is used.' }
  }
  return {
    windows: [
      {
        id: 'subscription',
        label,
        usedPercent: Math.min(100, Math.max(0, used)),
        ...(Number.isFinite(end) ? { resetsAt: end } : {}),
      },
    ],
  }
}

/** Asks xAI how much of the signed-in account's plan is used. Never throws. */
export async function readGrokLimits(deps: GrokLimitsDeps = {}): Promise<GrokLimits> {
  const { token, note } = await readGrokToken(deps)
  if (!token) return { windows: [], note }
  try {
    const res = await (deps.fetchFn ?? fetch)(BILLING_URL, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      return {
        windows: [],
        note:
          res.status === 401 || res.status === 403
            ? 'Grok rejected the stored sign-in. Run `grok login` again.'
            : 'Grok’s plan limits could not be read right now.',
      }
    }
    return grokUsageToLimits((await res.json()) as BillingResponse)
  } catch {
    return { windows: [], note: 'Grok’s plan limits could not be read right now.' }
  }
}
