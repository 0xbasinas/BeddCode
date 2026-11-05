// Policy checks for GitHub webhooks: sender allowlist, fork detection and per-sender rate limiting.
/** Who a webhook says did something. */
export interface Actor {
  login: string
  /** `User`, `Bot` or `Organization`. */
  type?: string
}

export const parseList = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\[bot\]$/, ''))
    .filter(Boolean)

/**
 * May this person start a job? Only listed logins, and never bots, so the app cannot trigger itself
 * through its own replies.
 */
export function allowedSender(actor: Actor | undefined, allowed: string[]): boolean {
  if (!actor?.login || actor.type === 'Bot' || actor.login.endsWith('[bot]')) return false
  return allowed.includes(actor.login.toLowerCase())
}

interface Repo {
  full_name?: string
}

/**
 * A pull request from a fork is ignored: its branch lives in someone else's repository, and its
 * code and CI log are not ours to run. A pull request whose head repo is missing counts as a fork.
 */
export function fromFork(pr: { head?: { repo?: Repo | null }; base?: { repo?: Repo | null } }) {
  const head = pr.head?.repo?.full_name
  const base = pr.base?.repo?.full_name
  return !head || !base || head.toLowerCase() !== base.toLowerCase()
}

/** A sliding window per sender. Returns whether another job fits and the times to keep. */
export function withinLimit(times: number[], now: number, limit: number, windowMs = 3_600_000) {
  const recent = times.filter((t) => now - t < windowMs)
  return recent.length < limit
    ? { ok: true, recent: [...recent, now] }
    : { ok: false, recent }
}
