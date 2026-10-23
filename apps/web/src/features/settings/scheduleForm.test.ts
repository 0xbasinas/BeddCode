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
    expect(formToInput({ ...form, minutes: '0' })).toMatchObject({
      error: expect.stringMatching(/minutes/),
    })
    expect(formToInput({ ...form, triggerKind: 'cron', expr: '* *' })).toMatchObject({
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
    expect(describeTrigger({ kind: 'cron', expr: '0 9 * * 1-5' })).toBe('Cron 0 9 * * 1-5')
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
})
