import { randomInt } from 'node:crypto'
import type { PairingCode } from '@beddcode/contracts'

const CODE_TTL_MS = 10 * 60_000
const MAX_FAILURES = 5
const FAILURE_WINDOW_MS = 60_000
const LOCKOUT_MS = 60_000

export type RedeemResult = 'ok' | 'invalid' | 'locked'

/**
 * Short-lived one-time codes. Six digits are easy to type but easy to guess, so wrong guesses
 * are counted for the whole host: after a few within a minute, redeeming stops for a while.
 */
export class PairingManager {
  private codes = new Map<string, number>()
  private failures: number[] = []
  private lockedUntil = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = () => randomInt(0, 1_000_000),
  ) {}

  create(): PairingCode {
    this.prune()
    let code = ''
    do code = String(this.random()).padStart(6, '0')
    while (this.codes.has(code))
    const expiresAt = this.now() + CODE_TTL_MS
    this.codes.set(code, expiresAt)
    return { code, expiresAt }
  }

  /** Uses up the code when it is right. */
  redeem(code: string): RedeemResult {
    const t = this.now()
    if (t < this.lockedUntil) return 'locked'
    this.prune()

    if (this.codes.delete(code.trim())) return 'ok'

    this.failures = this.failures.filter((f) => t - f < FAILURE_WINDOW_MS)
    this.failures.push(t)
    if (this.failures.length >= MAX_FAILURES) {
      this.failures = []
      this.lockedUntil = t + LOCKOUT_MS
      // Someone is guessing: codes handed out so far are no longer safe to keep around.
      this.codes.clear()
      return 'locked'
    }
    return 'invalid'
  }

  private prune() {
    const t = this.now()
    for (const [code, expires] of this.codes) if (expires <= t) this.codes.delete(code)
  }
}
