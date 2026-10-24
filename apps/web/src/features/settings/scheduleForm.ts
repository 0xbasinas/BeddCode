import type { Schedule, ScheduleInput, ScheduleRun, ScheduleTrigger } from '@beddcode/contracts'

/** The schedule editor's fields, as typed. */
export interface ScheduleForm {
  id?: string
  name: string
  prompt: string
  triggerKind: 'every' | 'cron'
  minutes: string
  expr: string
  targetKind: 'new' | 'session'
  instanceId: string
  /** A project folder; empty for a session without one. */
  cwd: string
  permissionMode: string
  model: string
  worktree: boolean
  sessionId: string
}

export function emptyScheduleForm(instanceId = ''): ScheduleForm {
  return {
    name: '',
    prompt: '',
    triggerKind: 'every',
    minutes: '60',
    expr: '0 9 * * 1-5',
    targetKind: 'new',
    instanceId,
    cwd: '',
    permissionMode: '',
    model: '',
    worktree: false,
    sessionId: '',
  }
}

export function scheduleToForm(s: Schedule): ScheduleForm {
  const base = emptyScheduleForm()
  return {
    ...base,
    id: s.id,
    name: s.name,
    prompt: s.prompt,
    triggerKind: s.trigger.kind,
    minutes: s.trigger.kind === 'every' ? String(s.trigger.minutes) : base.minutes,
    expr: s.trigger.kind === 'cron' ? s.trigger.expr : base.expr,
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
  }
}

export function formTrigger(form: ScheduleForm): ScheduleTrigger | { error: string } {
  if (form.triggerKind === 'cron') {
    const expr = form.expr.trim()
    if (expr.split(/\s+/).length !== 5 && !expr.startsWith('@'))
      return { error: 'A cron expression has five fields: minute hour day month weekday' }
    return { kind: 'cron', expr }
  }
  const minutes = Number(form.minutes)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080)
    return { error: 'Pick a whole number of minutes, from 1 to 10080 (a week)' }
  return { kind: 'every', minutes }
}

/** The editor's fields as the host takes them, or what is missing. */
export function formToInput(form: ScheduleForm): { input: ScheduleInput } | { error: string } {
  const name = form.name.trim()
  const prompt = form.prompt.trim()
  if (!name) return { error: 'Give the schedule a name' }
  if (!prompt) return { error: 'Write the prompt it should send' }
  const trigger = formTrigger(form)
  if ('error' in trigger) return trigger
  if (form.targetKind === 'session') {
    if (!form.sessionId) return { error: 'Pick the session to send it to' }
    return {
      input: {
        id: form.id,
        name,
        prompt,
        trigger,
        target: { kind: 'session', sessionId: form.sessionId },
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
    },
  }
}

/** "Every 15 minutes", "Every day", "Cron 0 9 * * 1-5". */
export function describeTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === 'cron') return `Cron ${trigger.expr}`
  const m = trigger.minutes
  if (m === 1) return 'Every minute'
  if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`
  if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`
  return `Every ${m} minutes`
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
  return run.note ? `${what}: ${run.note}` : what
}
