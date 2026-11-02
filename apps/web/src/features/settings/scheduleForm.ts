import type { Schedule, ScheduleInput, ScheduleRun, ScheduleTrigger } from '@beddcode/contracts'

/** How the editor lets someone say when a schedule fires. */
export type Repeat = 'every' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron'
export type Notify = NonNullable<ScheduleInput['notify']>

/** The schedule editor's fields, as typed. */
export interface ScheduleForm {
  id?: string
  name: string
  prompt: string
  repeat: Repeat
  /** "Every N minutes". */
  minutes: string
  /** Hourly: the minute past the hour. */
  minuteOfHour: string
  /** Daily, weekly and monthly: "09:00". */
  time: string
  /** Weekly: 0 is Sunday. */
  days: number[]
  /** Monthly. */
  monthDay: string
  /** Custom cron. */
  expr: string
  /** An IANA zone for the clock-based repeats; empty is the host's own. */
  timezone: string
  targetKind: 'new' | 'session'
  instanceId: string
  /** A project folder; empty for a session without one. */
  cwd: string
  permissionMode: string
  model: string
  worktree: boolean
  sessionId: string
  openPr: boolean
  retryOnFailure: boolean
  notify: Notify
  /** A new schedule starts running right away, or waits to be switched on. */
  enabled: boolean
}

export const WEEKDAYS = [1, 2, 3, 4, 5]
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function emptyScheduleForm(instanceId = ''): ScheduleForm {
  return {
    name: '',
    prompt: '',
    repeat: 'weekly',
    minutes: '60',
    minuteOfHour: '0',
    time: '09:00',
    days: [...WEEKDAYS],
    monthDay: '1',
    expr: '0 9 * * 1-5',
    timezone: '',
    targetKind: 'new',
    instanceId,
    cwd: '',
    permissionMode: '',
    model: '',
    worktree: false,
    sessionId: '',
    openPr: false,
    retryOnFailure: false,
    notify: 'always',
    enabled: true,
  }
}

const two = (n: number) => String(n).padStart(2, '0')

/** "0-5,6" as a sorted list of weekdays, or undefined if it is anything fancier. */
function parseDays(text: string): number[] | undefined {
  const days = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^([0-7])(?:-([0-7]))?$/.exec(part)
    if (!m) return undefined
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    if (b < a) return undefined
    for (let d = a; d <= b; d++) days.add(d % 7)
  }
  return [...days].sort((x, y) => x - y)
}

/** The editor's fields for a cron expression that one of the friendly repeats could have made. */
function friendlyCron(expr: string): Partial<ScheduleForm> | undefined {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return undefined
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string]
  const num = /^\d{1,2}$/
  if (!num.test(m) || mon !== '*' || Number(m) > 59) return undefined
  if (h === '*' && dom === '*' && dow === '*')
    return { repeat: 'hourly', minuteOfHour: String(Number(m)) }
  if (!num.test(h) || Number(h) > 23) return undefined
  const time = `${two(Number(h))}:${two(Number(m))}`
  if (dom === '*' && dow === '*') return { repeat: 'daily', time }
  if (dom === '*') {
    const days = parseDays(dow)
    return days?.length ? { repeat: 'weekly', time, days } : undefined
  }
  if (dow === '*' && num.test(dom) && Number(dom) >= 1 && Number(dom) <= 31)
    return { repeat: 'monthly', time, monthDay: String(Number(dom)) }
  return undefined
}

export function scheduleToForm(s: Schedule): ScheduleForm {
  const base = emptyScheduleForm()
  const trigger: Partial<ScheduleForm> =
    s.trigger.kind === 'every'
      ? { repeat: 'every', minutes: String(s.trigger.minutes) }
      : (friendlyCron(s.trigger.expr) ?? { repeat: 'cron', expr: s.trigger.expr })
  return {
    ...base,
    ...trigger,
    id: s.id,
    name: s.name,
    prompt: s.prompt,
    timezone: s.trigger.kind === 'cron' ? (s.trigger.timezone ?? '') : '',
    targetKind: s.target.kind,
    ...(s.target.kind === 'new'
      ? {
          instanceId: s.target.instanceId,
          cwd: s.target.cwd ?? '',
          permissionMode: s.target.permissionMode ?? '',
          model: s.target.model ?? '',
          worktree: s.target.worktree === true,
        }
      : { sessionId: s.target.sessionId }),
    openPr: s.openPr === true,
    retryOnFailure: s.retryOnFailure === true,
    notify: s.notify ?? 'always',
    enabled: !s.paused,
  }
}

/** The cron expression a friendly repeat stands for, or what is wrong with it. */
function cronFor(form: ScheduleForm): string | { error: string } {
  const [h, m] = form.time.split(':').map(Number)
  const clock =
    Number.isInteger(h) && Number.isInteger(m) && h! >= 0 && h! < 24 && m! >= 0 && m! < 60
  switch (form.repeat) {
    case 'hourly': {
      const minute = Number(form.minuteOfHour)
      if (!Number.isInteger(minute) || minute < 0 || minute > 59)
        return { error: 'The minute past the hour is a number from 0 to 59' }
      return `${minute} * * * *`
    }
    case 'daily':
      return clock ? `${m} ${h} * * *` : { error: 'Pick a time of day' }
    case 'weekly': {
      if (!clock) return { error: 'Pick a time of day' }
      if (form.days.length === 0) return { error: 'Pick at least one day' }
      const days = [...form.days].sort((a, b) => a - b)
      const weekdays = days.join(',') === WEEKDAYS.join(',')
      return `${m} ${h} * * ${weekdays ? '1-5' : days.join(',')}`
    }
    case 'monthly': {
      if (!clock) return { error: 'Pick a time of day' }
      const day = Number(form.monthDay)
      if (!Number.isInteger(day) || day < 1 || day > 31)
        return { error: 'The day of the month is a number from 1 to 31' }
      return `${m} ${h} ${day} * *`
    }
    default:
      return form.expr.trim()
  }
}

export function formTrigger(form: ScheduleForm): ScheduleTrigger | { error: string } {
  if (form.repeat === 'every') {
    const minutes = Number(form.minutes)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080)
      return { error: 'Pick a whole number of minutes, from 1 to 10080 (a week)' }
    return { kind: 'every', minutes }
  }
  const expr = cronFor(form)
  if (typeof expr !== 'string') return expr
  if (expr.split(/\s+/).length !== 5 && !expr.startsWith('@'))
    return { error: 'A cron expression has five fields: minute hour day month weekday' }
  return { kind: 'cron', expr, ...(form.timezone ? { timezone: form.timezone } : {}) }
}

/** The editor's fields as the host takes them, or what is missing. */
export function formToInput(form: ScheduleForm): { input: ScheduleInput } | { error: string } {
  const name = form.name.trim()
  const prompt = form.prompt.trim()
  if (!name) return { error: 'Give the schedule a name' }
  if (!prompt) return { error: 'Write the prompt it should send' }
  const trigger = formTrigger(form)
  if ('error' in trigger) return trigger
  const options = {
    // A saved schedule keeps its own on/off state; a new one can start switched off.
    paused: form.id || form.enabled ? undefined : true,
    openPr: (form.targetKind === 'new' && form.openPr) || undefined,
    retryOnFailure: form.retryOnFailure || undefined,
    notify: form.notify === 'always' ? undefined : form.notify,
  }
  if (form.targetKind === 'session') {
    if (!form.sessionId) return { error: 'Pick the session to send it to' }
    return {
      input: {
        id: form.id,
        name,
        prompt,
        trigger,
        target: { kind: 'session', sessionId: form.sessionId },
        ...options,
      },
    }
  }
  if (!form.instanceId) return { error: 'Pick an agent' }
  return {
    input: {
      id: form.id,
      name,
      prompt,
      trigger,
      target: {
        kind: 'new',
        instanceId: form.instanceId,
        cwd: form.cwd || undefined,
        projectless: form.cwd ? undefined : true,
        permissionMode: form.permissionMode || undefined,
        model: form.model || undefined,
        worktree: (form.cwd && form.worktree) || undefined,
      },
      ...options,
    },
  }
}

function daysText(days: number[]): string {
  if (days.length === 7) return 'Every day'
  if (days.join(',') === WEEKDAYS.join(',')) return 'Weekdays'
  if (days.join(',') === '0,6') return 'Weekends'
  return days.map((d) => DAY_NAMES[d]).join(', ')
}

/** "Every 15 minutes", "Weekdays at 09:00", "Monthly on day 1 at 08:00", "Cron 0 9 1 1 *". */
export function describeTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === 'cron') {
    const friendly = friendlyCron(trigger.expr)
    if (friendly?.repeat === 'hourly') return `Every hour at :${two(Number(friendly.minuteOfHour))}`
    if (friendly?.repeat === 'daily') return `Every day at ${friendly.time}`
    if (friendly?.repeat === 'weekly') return `${daysText(friendly.days ?? [])} at ${friendly.time}`
    if (friendly?.repeat === 'monthly')
      return `Monthly on day ${friendly.monthDay} at ${friendly.time}`
    return `Cron ${trigger.expr}`
  }
  const m = trigger.minutes
  if (m === 1) return 'Every minute'
  if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`
  if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`
  return `Every ${m} minutes`
}

/** "Runs every weekday at 09:00, Europe/Athens." */
export function summaryLine(trigger: ScheduleTrigger): string {
  const text = describeTrigger(trigger)
  const spoken = text.startsWith('Weekdays')
    ? text.replace('Weekdays', 'every weekday')
    : /^(Every|Monthly|Weekends)/.test(text)
      ? text[0]!.toLowerCase() + text.slice(1)
      : `on ${text}`
  const zone = trigger.kind === 'cron' ? `, ${trigger.timezone ?? 'in the host’s time zone'}` : ''
  return `Runs ${spoken}${zone}.`
}

const RUN_STATUS: Record<ScheduleRun['status'], string> = {
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Stopped',
  skipped: 'Skipped',
}

export function runLabel(run: ScheduleRun): string {
  const what = RUN_STATUS[run.status]
  const label = run.note ? `${what}: ${run.note}` : what
  return run.retry ? `${label} (retry)` : label
}
