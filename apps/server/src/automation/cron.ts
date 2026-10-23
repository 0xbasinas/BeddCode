import type { ScheduleTrigger } from '@beddcode/contracts'

/** A parsed five-field cron expression: minute, hour, day of month, month, day of week. */
export interface Cron {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** Day of month and day of week were both restricted: either may match, as in classic cron. */
  eitherDay: boolean
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const SHORTHANDS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

function field(text: string, min: number, max: number, names?: string[], offset = 0): Set<number> {
  const out = new Set<number>()
  const value = (v: string) => {
    const named = names?.indexOf(v.toLowerCase()) ?? -1
    const n = named >= 0 ? named + offset : Number(v)
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`"${v}" is out of range`)
    return n
  }
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`"${part}" has a bad step`)
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-')
      lo = value(a!)
      hi = value(b!)
      if (hi < lo) throw new Error(`"${part}" runs backwards`)
    } else {
      lo = value(range!)
      hi = stepText === undefined ? lo : max
    }
    for (let n = lo; n <= hi; n += step) out.add(n)
  }
  return out
}

export function parseCron(expr: string): Cron {
  const text = SHORTHANDS[expr.trim().toLowerCase()] ?? expr.trim()
  const parts = text.split(/\s+/)
  if (parts.length !== 5)
    throw new Error('Use five fields: minute hour day-of-month month day-of-week')
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string]
  const weekdays = field(dow, 0, 7, DAYS)
  // 7 is Sunday too.
  if (weekdays.delete(7)) weekdays.add(0)
  return {
    minutes: field(m, 0, 59),
    hours: field(h, 0, 23),
    days: field(dom, 1, 31),
    months: field(mon, 1, 12, MONTHS, 1),
    weekdays,
    eitherDay: dom !== '*' && dow !== '*',
  }
}

function dayMatches(cron: Cron, d: Date): boolean {
  const dom = cron.days.has(d.getDate())
  const dow = cron.weekdays.has(d.getDay())
  return cron.eitherDay ? dom || dow : dom && dow
}

/** The first minute strictly after `after` that the expression matches, in local time. */
export function nextCron(cron: Cron, after: number): number | undefined {
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = after + 4 * 366 * 24 * 60 * 60_000
  while (d.getTime() <= limit) {
    if (!cron.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(cron, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!cron.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!cron.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
      continue
    }
    return d.getTime()
  }
  return undefined
}

/**
 * When a trigger fires next after `after`. Intervals count from the last run (or from when the
 * schedule was saved), so a host that was off does not fire a burst of missed runs on waking.
 */
export function nextRun(
  trigger: ScheduleTrigger,
  after: number,
  anchor?: number,
): number | undefined {
  if (trigger.kind === 'every') {
    const period = trigger.minutes * 60_000
    const from = anchor ?? after
    if (from + period > after) return from + period
    // Missed runs are not made up: the next one is a whole period from now.
    return after + period - ((after - from) % period)
  }
  return nextCron(parseCron(trigger.expr), after)
}

/** The next `count` times a trigger fires, or why it cannot. */
export function previewTrigger(
  trigger: ScheduleTrigger,
  now: number,
  count = 3,
): { times: number[]; error?: string } {
  try {
    const times: number[] = []
    let at = now
    let anchor: number | undefined = now
    for (let i = 0; i < count; i++) {
      const next = nextRun(trigger, at, anchor)
      if (next === undefined) break
      times.push(next)
      at = next
      anchor = next
    }
    if (times.length === 0) return { times, error: 'This never fires' }
    return { times }
  } catch (err) {
    return { times: [], error: err instanceof Error ? err.message : String(err) }
  }
}
