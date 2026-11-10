import { describe, expect, it } from 'vitest'
import type { Schedule } from '@beddcode/contracts'
import {
  describeTrigger,
  emptyScheduleForm,
  formToInput,
  runLabel,
  scheduleToForm,
} from './scheduleForm.ts'

describe('schedule form', () => {
  it('turns a filled-in form into what the host takes', () => {
    const form = {
      ...emptyScheduleForm('codex'),
      name: ' Triage ',
      prompt: 'Check CI',
      cwd: '/w',
      worktree: true,
      repeat: 'every' as const,
    }
    expect(formToInput(form)).toEqual({
      input: {
        id: undefined,
        name: 'Triage',
        prompt: 'Check CI',
        trigger: { kind: 'every', minutes: 60 },
        target: {
          kind: 'new',
          instanceId: 'codex',
          cwd: '/w',
          projectless: undefined,
          permissionMode: undefined,
          model: undefined,
          worktree: true,
        },
      },
    })
    const noFolder = formToInput({ ...form, cwd: '' })
    expect('input' in noFolder && noFolder.input.target).toMatchObject({
      projectless: true,
      worktree: undefined,
    })
  })

  it('says what is missing', () => {
    const form = { ...emptyScheduleForm('codex'), name: 'x', prompt: 'p' }
    expect(formToInput({ ...form, name: ' ' })).toEqual({ error: 'Give the schedule a name' })
    expect(formToInput({ ...form, repeat: 'every', minutes: '0' })).toMatchObject({
      error: expect.stringMatching(/minutes/),
    })
    expect(formToInput({ ...form, repeat: 'cron', expr: '* *' })).toMatchObject({
      error: expect.stringMatching(/five fields/),
    })
    expect(formToInput({ ...form, targetKind: 'session' })).toEqual({
      error: 'Pick the session to send it to',
    })
  })

  it('round-trips a saved heartbeat schedule', () => {
    const saved: Schedule = {
      id: 's1',
      name: 'Ping',
      prompt: 'Any news?',
      paused: false,
      createdAt: 0,
      trigger: { kind: 'cron', expr: '*/30 * * * *' },
      target: { kind: 'session', sessionId: 'abc' },
    }
    const form = scheduleToForm(saved)
    expect(formToInput(form)).toEqual({
      input: {
        id: 's1',
        name: 'Ping',
        prompt: 'Any news?',
        trigger: saved.trigger,
        target: saved.target,
      },
    })
  })

  it('describes triggers and runs in words', () => {
    expect(describeTrigger({ kind: 'every', minutes: 1 })).toBe('Every minute')
    expect(describeTrigger({ kind: 'every', minutes: 45 })).toBe('Every 45 minutes')
    expect(describeTrigger({ kind: 'every', minutes: 120 })).toBe('Every 2 hours')
    expect(describeTrigger({ kind: 'every', minutes: 1440 })).toBe('Every day')
    expect(describeTrigger({ kind: 'cron', expr: '0 9 * * 1-5' })).toBe('Weekdays at 09:00')
    expect(describeTrigger({ kind: 'cron', expr: '30 16 * * 5' })).toBe('Fri at 16:30')
    expect(describeTrigger({ kind: 'cron', expr: '0 8 1 * *' })).toBe('Monthly on day 1 at 08:00')
    expect(describeTrigger({ kind: 'cron', expr: '0 9 1 1 *' })).toBe('Cron 0 9 1 1 *')
    expect(
      runLabel({
        id: 'r',
        scheduleId: 's',
        startedAt: 0,
        status: 'skipped',
        note: 'Still running',
      }),
    ).toBe('Skipped: Still running')
  })

  it('builds a weekly schedule in a time zone, and reads it back', () => {
    const form = {
      ...emptyScheduleForm('codex'),
      name: 'Audit',
      prompt: 'Look',
      repeat: 'weekly' as const,
      days: [1, 3, 5],
      time: '07:30',
      timezone: 'Europe/Athens',
      openPr: true,
      retryOnFailure: true,
      notify: 'failure' as const,
      enabled: false,
    }
    const result = formToInput(form)
    expect(result).toMatchObject({
      input: {
        trigger: { kind: 'cron', expr: '30 7 * * 1,3,5', timezone: 'Europe/Athens' },
        openPr: true,
        retryOnFailure: true,
        notify: 'failure',
        paused: true,
      },
    })
    const saved = {
      ...('input' in result ? result.input : {}),
      id: 's9',
      paused: true,
      createdAt: 0,
    }
    expect(scheduleToForm(saved as Schedule)).toMatchObject({
      repeat: 'weekly',
      days: [1, 3, 5],
      time: '07:30',
      timezone: 'Europe/Athens',
      openPr: true,
      enabled: false,
    })
    expect(formToInput({ ...form, days: [] })).toEqual({ error: 'Pick at least one day' })
  })
})

describe('watch schedules', () => {
  it('round-trips a watch trigger through the form', () => {
    const form = {
      ...emptyScheduleForm('codex'),
      name: 'Tests on change',
      prompt: 'run the tests',
      repeat: 'watch' as const,
      glob: 'src/**/*.ts',
      debounceMinutes: '10',
      cwd: '/proj',
    }
    const result = formToInput(form)
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.input.trigger).toEqual({
        kind: 'watch',
        glob: 'src/**/*.ts',
        debounceMinutes: 10,
      })
    }
    const saved: Schedule = {
      id: 'w1',
      name: 'Tests on change',
      prompt: 'run the tests',
      trigger: { kind: 'watch', glob: 'src/**/*.ts', debounceMinutes: 10 },
      target: { kind: 'new', instanceId: 'codex', cwd: '/proj' },
      paused: false,
      createdAt: 0,
    }
    const back = scheduleToForm(saved)
    expect(back.repeat).toBe('watch')
    expect(back.glob).toBe('src/**/*.ts')
    expect(back.debounceMinutes).toBe('10')
    expect(describeTrigger(saved.trigger)).toContain('src/**/*.ts')
  })

  it('rejects an empty glob or a bad debounce', () => {
    const base = { ...emptyScheduleForm('codex'), name: 'n', prompt: 'p', repeat: 'watch' as const }
    expect('error' in formToInput({ ...base, glob: '  ' })).toBe(true)
    expect('error' in formToInput({ ...base, glob: 'ok', debounceMinutes: '0' })).toBe(true)
    expect('error' in formToInput({ ...base, glob: 'ok', debounceMinutes: '5' })).toBe(false)
  })
})
