import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Schedule, ScheduleRun, SessionEvent, StoredEvent } from '@beddcode/contracts'
import { createLogger } from '@beddcode/shared'
import { ScheduleService, type ScheduleHost } from './schedules.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function setup(start = new Date(2026, 9, 23, 10, 0).getTime()) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-sched-'))
  dirs.push(dir)
  let now = start
  const logs = new Map<string, StoredEvent[]>()
  const listeners = new Set<(e: StoredEvent) => void>()
  let seq = 0
  const append = (event: SessionEvent) => {
    const stored = { seq: ++seq, event }
    logs.set(event.sessionId, [...(logs.get(event.sessionId) ?? []), stored])
    listeners.forEach((l) => l(stored))
  }
  const busy = new Set<string>()
  const prompts: [string, string][] = []
  let n = 0
  const host: ScheduleHost = {
    async create(params, origin) {
      const sessionId = `s${++n}`
      append({
        type: 'session.created',
        sessionId,
        at: now,
        title: params.title ?? '',
        cwd: params.cwd ?? '/w',
        instanceId: params.instanceId,
        schedule: origin.schedule,
      })
      return { sessionId }
    },
    async prompt(sessionId, text) {
      prompts.push([sessionId, text])
      busy.add(sessionId)
      return { state: 'started' }
    },
    isBusy: (id) => busy.has(id),
    readSession: (id) => logs.get(id) ?? [],
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
  const ended: [ScheduleRun, Schedule][] = []
  const make = () =>
    new ScheduleService({
      file: path.join(dir, 'schedules.json'),
      host,
      log: createLogger('test', 'error'),
      now: () => now,
      tickMs: 1_000_000,
      onRunEnded: (run, s) => ended.push([run, s]),
    })
  const finish = (sessionId: string, reason: 'done' | 'error' = 'done') => {
    busy.delete(sessionId)
    append({ type: 'turn.completed', sessionId, at: now, reason })
  }
  return {
    make,
    host,
    append,
    prompts,
    ended,
    finish,
    busy,
    advance: (ms: number) => (now += ms),
    get now() {
      return now
    },
  }
}

const NEW = { kind: 'new' as const, instanceId: 'codex', cwd: '/w' }

describe('ScheduleService', () => {
  it('fires every N minutes, a fresh session each time, and records the runs', async () => {
    const t = setup()
    const svc = t.make()
    svc.start()
    const s = svc.saveSchedule({
      name: 'Triage',
      prompt: 'Check CI',
      trigger: { kind: 'every', minutes: 5 },
      target: NEW,
    })
    expect(s.nextRunAt).toBe(t.now + 5 * 60_000)

    await svc.tick()
    expect(t.prompts).toHaveLength(0)
    t.advance(5 * 60_000)
    await svc.tick()
    expect(t.prompts).toEqual([['s1', 'Check CI']])
    expect(svc.list().runs[0]).toMatchObject({ status: 'running', sessionId: 's1' })
    t.finish('s1')
    expect(svc.list().runs[0]).toMatchObject({ status: 'done' })
    expect(t.ended.map(([r, sc]) => [r.status, sc.name])).toEqual([['done', 'Triage']])
    expect(svc.coversTurn('s1')).toBe(true)

    t.advance(5 * 60_000)
    await svc.tick()
    expect(t.prompts.map(([id]) => id)).toEqual(['s1', 's2'])
    // The created session says which schedule started it.
    const created = t.host.readSession('s2')[0]!.event
    expect(created.type === 'session.created' && created.schedule).toEqual({
      id: s.id,
      name: 'Triage',
    })
    svc.stop()
  })

  it('skips a run while the previous one is still going, and a busy heartbeat session', async () => {
    const t = setup()
    const svc = t.make()
    svc.start()
    const s = svc.saveSchedule({
      name: 'A',
      prompt: 'p',
      trigger: { kind: 'every', minutes: 1 },
      target: NEW,
    })
    await svc.runNow(s.id)
    expect((await svc.runNow(s.id)).status).toBe('skipped')

    await t.host.create({ instanceId: 'codex' }, {})
    const hb = svc.saveSchedule({
      name: 'Heartbeat',
      prompt: 'Any news?',
      trigger: { kind: 'every', minutes: 1 },
      target: { kind: 'session', sessionId: 's2' },
    })
    t.busy.add('s2')
    expect(await svc.runNow(hb.id)).toMatchObject({
      status: 'skipped',
      note: 'The session was busy',
    })
    t.busy.delete('s2')
    expect(await svc.runNow(hb.id)).toMatchObject({ status: 'running', sessionId: 's2' })
    expect(t.prompts.at(-1)).toEqual(['s2', 'Any news?'])
    svc.stop()
  })

  it('pauses and resumes, rejects bad cron, and survives a restart without a burst of runs', async () => {
    const t = setup()
    const svc = t.make()
    svc.start()
    expect(() =>
      svc.saveSchedule({
        name: 'Bad',
        prompt: 'p',
        trigger: { kind: 'cron', expr: '99 * * * *' },
        target: NEW,
      }),
    ).toThrow(/out of range/)
    const s = svc.saveSchedule({
      name: 'Hourly',
      prompt: 'p',
      trigger: { kind: 'cron', expr: '0 * * * *' },
      target: NEW,
    })
    expect(svc.setPaused(s.id, true).nextRunAt).toBeUndefined()
    t.advance(2 * 60 * 60_000)
    await svc.tick()
    expect(t.prompts).toHaveLength(0)
    expect(svc.setPaused(s.id, false).nextRunAt).toBe(new Date(2026, 9, 23, 13, 0).getTime())
    svc.stop()

    // Off for a day: on start it fires next from now, not 24 times.
    t.advance(24 * 60 * 60_000)
    const again = t.make()
    again.start()
    expect(again.list().schedules[0]!.nextRunAt).toBeGreaterThan(t.now)
    await again.tick()
    expect(t.prompts).toHaveLength(0)
    expect(again.remove(s.id)).toBe(true)
    again.stop()
  })

  it('records a run that could not start as an error and reports it', async () => {
    const t = setup()
    t.host.create = async () => {
      throw new Error('Codex is not signed in')
    }
    const svc = t.make()
    svc.start()
    const s = svc.saveSchedule({
      name: 'X',
      prompt: 'p',
      trigger: { kind: 'every', minutes: 1 },
      target: NEW,
    })
    expect(await svc.runNow(s.id)).toMatchObject({
      status: 'error',
      note: 'Codex is not signed in',
      manual: true,
    })
    expect(t.ended).toHaveLength(1)
    svc.stop()
  })
})
