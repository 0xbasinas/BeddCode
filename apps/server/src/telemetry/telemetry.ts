import type { MetricPlatform, MetricRecord } from '@beddcode/contracts'
import type { Logger } from '@beddcode/shared'

export interface TelemetryOptions {
  /** Where the relay is, with the password it asks of hosts. Undefined while there is no relay. */
  target(): { url: string; password: string } | undefined
  /** Whether its owner turned uploads on. */
  enabled(): boolean
  /** A short label for this computer in the numbers (never its name). */
  hostLabel: string
  log: Logger
  fetch?: typeof fetch
  intervalMs?: number
}

type Platform = MetricPlatform | 'host'

const MAX_QUEUED = 2000
const BATCH = 400

/** The relay's web address for a websocket one. */
export const httpUrl = (url: string) =>
  url.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '')

/**
 * Collects the speed measurements apps report to this host (and the host's own) and uploads them
 * to the owner's relay, if the owner turned that on. Only numbers and short labels pass through
 * here; see MetricRecord in the contracts.
 */
export class Telemetry {
  private queue: { platform: Platform; record: MetricRecord }[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private busy = false

  constructor(private readonly options: TelemetryOptions) {}

  /** Takes a client's measurements. False means they are not being kept, so it can stop sending. */
  report(platform: MetricPlatform, records: MetricRecord[]): boolean {
    if (!this.options.enabled() || !this.options.target()) return false
    for (const record of records) this.push(platform, record)
    return true
  }

  /** A measurement of the host itself. */
  record(name: string, value: number, tags?: MetricRecord['tags']) {
    if (!this.options.enabled() || !this.options.target()) return
    this.push('host', { t: Date.now(), name, value: Math.round(value * 10) / 10, tags })
  }

  private push(platform: Platform, record: MetricRecord) {
    this.queue.push({ platform, record })
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED)
    this.timer ??= setTimeout(() => void this.flush(), this.options.intervalMs ?? 30_000)
    this.timer.unref?.()
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const target = this.options.target()
    if (this.busy || !target || !this.options.enabled() || this.queue.length === 0) return
    this.busy = true
    const send = this.options.fetch ?? fetch
    const taken = this.queue.splice(0, BATCH)
    try {
      const byPlatform = new Map<Platform, MetricRecord[]>()
      for (const { platform, record } of taken) {
        const list = byPlatform.get(platform) ?? []
        list.push(record)
        byPlatform.set(platform, list)
      }
      for (const [platform, records] of byPlatform) {
        const res = await send(`${httpUrl(target.url)}/metrics`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${target.password}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ host: this.options.hostLabel, platform, records }),
          signal: AbortSignal.timeout(10_000),
        })
        // Refused outright (wrong password, bad data): retrying the same thing would not help.
        if (!res.ok && res.status !== 429 && res.status < 500)
          this.options.log.debug(`telemetry refused: ${res.status}`)
        else if (!res.ok) throw new Error(`relay answered ${res.status}`)
      }
    } catch (err) {
      this.options.log.debug(`telemetry not sent: ${err instanceof Error ? err.message : err}`)
      this.queue.unshift(...taken)
      if (this.queue.length > MAX_QUEUED) this.queue.splice(MAX_QUEUED)
    } finally {
      this.busy = false
      if (this.queue.length) this.timer ??= setTimeout(() => void this.flush(), 60_000)
      this.timer?.unref?.()
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** A short, safe label for a host id. */
export const hostLabel = (hostId: string) =>
  hostId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 16) || 'host'
