import type { HostClient } from './hostClient.ts'
import type { MetricPlatform, MetricRecord } from '@beddcode/contracts'

export type Tags = Record<string, string | number | boolean>

/** Milliseconds from a clock that does not jump, where the platform has one. */
export const now = (): number => globalThis.performance?.now?.() ?? Date.now()

const MAX_KEPT = 500
const safe = (v: string | number | boolean) =>
  String(v)
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 40)

/**
 * Keeps the latest measurements (a number, a name and a few short labels, never content) so they
 * can be shown on a diagnostics screen or sent on to the host (see `startTelemetry`).
 */
export class Recorder {
  private records: MetricRecord[] = []
  private readonly listeners = new Set<() => void>()

  record(name: string, value: number, tags?: Tags) {
    const entry: MetricRecord = { t: Date.now(), name, value: Math.round(value * 10) / 10 }
    if (tags) entry.tags = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, safe(v)]))
    this.records.push(entry)
    if (this.records.length > MAX_KEPT) this.records.splice(0, this.records.length - MAX_KEPT)
    for (const listener of this.listeners) listener()
  }

  /** The newest measurements, oldest first. */
  get recent(): readonly MetricRecord[] {
    return this.records
  }

  /** Takes up to `max` of the oldest measurements out, to send them. */
  drain(max: number): MetricRecord[] {
    return this.records.splice(0, max)
  }

  /** Puts measurements back at the front, as when sending them failed. */
  restore(records: MetricRecord[]) {
    this.records = [...records, ...this.records].slice(-MAX_KEPT)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/**
 * Sends a host client's measurements to that host a few seconds after they are taken. The host
 * passes them on only if its owner turned that on; when it says no, this stops for good.
 */
export function startTelemetry(
  client: HostClient,
  platform: MetricPlatform,
  options: { delayMs?: number } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let off = false
  const flush = async () => {
    timer = null
    if (off || client.connectionState !== 'connected') return
    const records = client.perf.drain(200)
    if (records.length === 0) return
    try {
      const { accepted } = await client.request('telemetry.report', { platform, records })
      if (!accepted) off = true
    } catch {
      client.perf.restore(records)
    }
  }
  const schedule = () => {
    if (!off && !timer) timer = setTimeout(() => void flush(), options.delayMs ?? 5_000)
  }
  const unsubscribe = client.perf.subscribe(schedule)
  schedule()
  return () => {
    off = true
    if (timer) clearTimeout(timer)
    unsubscribe()
  }
}
