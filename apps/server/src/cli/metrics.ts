import { readConfigFile } from '../config.ts'
import { httpUrl } from '../telemetry/telemetry.ts'
import { parseArgs, num } from './args.ts'
import type { Io } from './io.ts'

interface Row {
  name: string
  platform: string
  route: string
  resume?: string
  count: number
  p50: number
  p95: number
  max: number
  avg: number
}

export interface MetricsSummary {
  days: number
  samples: number
  rows: Row[]
}

const fmt = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10).toString()

/** The summary as a table: one line per measurement, platform and route. */
export function formatSummary(summary: MetricsSummary): string {
  if (summary.rows.length === 0)
    return `No measurements in the last ${summary.days} day${summary.days === 1 ? '' : 's'}. Turn them on under Connect from anywhere in the desktop app, then use BeddCode for a bit.\n`
  const header = ['measurement', 'platform', 'route', 'start', 'count', 'p50', 'p95', 'max']
  const lines = summary.rows.map((r) => [
    r.name,
    r.platform,
    r.route || '-',
    r.resume || '-',
    String(r.count),
    fmt(r.p50),
    fmt(r.p95),
    fmt(r.max),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)))
  const row = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  return [
    row(header),
    ...lines.map(row),
    '',
    `${summary.samples} measurements over the last ${summary.days} day${summary.days === 1 ? '' : 's'}. ms are milliseconds, kb kilobytes.`,
    '',
  ].join('\n')
}

/** `beddcode metrics [--days N] [--json]`: what your relay has collected about speed. */
export async function metricsCmd(
  args: string[],
  io: Io,
  fetchFn: typeof fetch = fetch,
  config = readConfigFile(),
): Promise<number> {
  const { flags } = parseArgs(args, { bool: ['json'], string: ['days'] })
  const days = num(flags.days, 'days') ?? 7
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days is 1 to 30')
  const url = process.env.BEDDCODE_RELAY_URL ?? config.relayUrl
  const password = process.env.BEDDCODE_RELAY_PASSWORD ?? config.relayPassword
  if (!url || !password)
    throw new Error(
      'Metrics live on your relay: set its address and password first (beddcode config set relay-url … / relay-password …).',
    )
  const res = await fetchFn(`${httpUrl(url)}/metrics/summary?days=${days}`, {
    headers: { authorization: `Bearer ${password}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 401) throw new Error('The relay refused the password.')
  if (res.status === 503)
    throw new Error('The relay has no RELAY_PASSWORD set, so it keeps no metrics (see its README).')
  if (res.status === 404)
    throw new Error('This relay does not keep metrics. Redeploy it from the latest code.')
  if (!res.ok) throw new Error(`The relay answered ${res.status}.`)
  const summary = (await res.json()) as MetricsSummary
  io.out(flags.json === true ? `${JSON.stringify(summary, null, 2)}\n` : formatSummary(summary))
  return 0
}
