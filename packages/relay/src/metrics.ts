/**
 * The measurements BeddCode keeps on your relay: a number, a name and a few short labels, never
 * content. The same checks the apps apply (see MetricRecord in @beddcode/contracts) are applied
 * again here, because this endpoint accepts whatever it is sent.
 */
export interface Sample {
  t: number
  name: string
  value: number
  tags?: Record<string, string>
}

export interface Batch {
  /** A short label for the computer the numbers came through. */
  host: string
  platform: 'web' | 'desktop' | 'mobile' | 'host'
  records: Sample[]
}

export const MAX_RECORDS_PER_BATCH = 500
export const MAX_BODY_BYTES = 256 * 1024
export const RETENTION_DAYS = 30

const NAME = /^[a-z0-9_.]{1,48}$/
const TAG_KEY = /^[a-z0-9_]{1,24}$/
const TAG_VALUE = /^[A-Za-z0-9_.:-]{0,40}$/
const HOST = /^[a-z0-9-]{1,16}$/
const PLATFORMS = new Set(['web', 'desktop', 'mobile', 'host'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Returns the batch if every part of it is well formed, otherwise null (nothing is kept). */
export function validateBatch(body: unknown): Batch | null {
  if (!isObject(body) || typeof body.host !== 'string' || !HOST.test(body.host)) return null
  if (typeof body.platform !== 'string' || !PLATFORMS.has(body.platform)) return null
  if (!Array.isArray(body.records) || body.records.length > MAX_RECORDS_PER_BATCH) return null
  const records: Sample[] = []
  for (const r of body.records) {
    if (!isObject(r)) return null
    if (typeof r.t !== 'number' || !Number.isInteger(r.t) || r.t < 0) return null
    if (typeof r.name !== 'string' || !NAME.test(r.name)) return null
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return null
    let tags: Record<string, string> | undefined
    if (r.tags !== undefined) {
      if (!isObject(r.tags)) return null
      const entries = Object.entries(r.tags)
      if (entries.length > 6) return null
      for (const [k, v] of entries)
        if (!TAG_KEY.test(k) || typeof v !== 'string' || !TAG_VALUE.test(v)) return null
      tags = r.tags as Record<string, string>
    }
    records.push({ t: r.t, name: r.name, value: r.value, ...(tags ? { tags } : {}) })
  }
  return { host: body.host, platform: body.platform as Batch['platform'], records }
}

/** The value below which `p` (0..1) of the sorted numbers fall. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index]!
}

export interface SummaryRow {
  name: string
  platform: string
  /** The `route` label (direct or relay) when the measurement has one. */
  route: string
  /** The `resume` label (cold or warm start) when the measurement has one. */
  resume: string
  count: number
  p50: number
  p95: number
  max: number
  avg: number
}

/** Exact nearest-rank percentiles, aggregated in SQLite without returning every raw sample. */
export function metricSummarySql(daily = false): string {
  const dimensions = `${daily ? 'day, ' : ''}name, platform, route, resume`
  return `WITH selected AS (
    SELECT ${daily ? "strftime('%Y-%m-%d', t / 1000.0, 'unixepoch') AS day," : ''}
      name, platform, COALESCE(route, '') AS route,
      COALESCE(json_extract(tags, '$.resume'), '') AS resume, value
    FROM samples WHERE t >= ?
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY ${dimensions} ORDER BY value) AS position,
      COUNT(*) OVER (PARTITION BY ${dimensions}) AS total
    FROM selected
  ) SELECT ${dimensions}, COUNT(*) AS count,
    MAX(CASE WHEN position = (total + 1) / 2 THEN value END) AS p50,
    MAX(CASE WHEN position = (95 * total + 99) / 100 THEN value END) AS p95
    ${daily ? '' : ', MAX(value) AS max, AVG(value) AS avg'}
  FROM ranked GROUP BY ${dimensions} ORDER BY ${daily ? 'day, ' : ''}name, platform, route, resume`
}

/** Groups samples by name, platform and route, with the figures worth looking at. */
export function summarize(
  rows: {
    name: string
    platform: string
    route: string | null
    resume?: string | null
    value: number
  }[],
): SummaryRow[] {
  const groups = new Map<string, { head: Omit<SummaryRow, 'count'>; values: number[] }>()
  for (const r of rows) {
    const route = r.route ?? ''
    const resume = r.resume ?? ''
    const key = `${r.name}\n${r.platform}\n${route}\n${resume}`
    let g = groups.get(key)
    if (!g) {
      g = {
        head: { name: r.name, platform: r.platform, route, resume, p50: 0, p95: 0, max: 0, avg: 0 },
        values: [],
      }
      groups.set(key, g)
    }
    g.values.push(r.value)
  }
  return [...groups.values()]
    .map(({ head, values }) => {
      const sorted = values.sort((a, b) => a - b)
      const sum = sorted.reduce((a, b) => a + b, 0)
      return {
        ...head,
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1]!,
        avg: sum / sorted.length,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.platform.localeCompare(b.platform))
}

export interface DailyPoint {
  /** The UTC day, YYYY-MM-DD. */
  day: string
  name: string
  platform: string
  route: string
  resume: string
  count: number
  p50: number
  p95: number
}

/** The same figures per UTC day, for drawing a trend. */
export function dailySeries(
  rows: {
    t: number
    name: string
    platform: string
    route: string | null
    resume?: string | null
    value: number
  }[],
): DailyPoint[] {
  const groups = new Map<
    string,
    { head: Omit<DailyPoint, 'count' | 'p50' | 'p95'>; values: number[] }
  >()
  for (const r of rows) {
    const day = new Date(r.t).toISOString().slice(0, 10)
    const route = r.route ?? ''
    const resume = r.resume ?? ''
    const key = `${day}\n${r.name}\n${r.platform}\n${route}\n${resume}`
    let g = groups.get(key)
    if (!g) {
      g = { head: { day, name: r.name, platform: r.platform, route, resume }, values: [] }
      groups.set(key, g)
    }
    g.values.push(r.value)
  }
  return [...groups.values()]
    .map(({ head, values }) => {
      const sorted = values.sort((a, b) => a - b)
      return {
        ...head,
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
      }
    })
    .sort((a, b) => a.day.localeCompare(b.day))
}
