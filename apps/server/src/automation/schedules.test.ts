import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Schedule, ScheduleRun, SessionEvent, StoredEvent } from '@beddcode/contracts'
import { createLogger } from '@beddcode/shared'
import { previewTrigger } from './cron.ts'
import { ScheduleService, type ScheduleHost } from './schedules.ts'
import type { WatchedFile } from './watchGlob.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function setup(
  start = new Date(2026, 9, 23, 10, 0).getTime(),
  scan?: (cwd: string, glob: string) => Promise<WatchedFile[]>,
) {
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
      ...(scan ? { scan } : {}),
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

  it('retries a failed run once, ten minutes later, before telling anyone', async () => {
    const t = setup()
    const svc = t.make()
    svc.start()
    const s = svc.saveSchedule({
      name: 'Flaky',
      prompt: 'p',
      trigger: { kind: 'every', minutes: 1440 },
      target: NEW,
      retryOnFailure: true,
    })
    t.advance(1440 * 60_000)
    await svc.tick()
    t.finish('s1', 'error')
    expect(t.ended).toHaveLength(0)
    expect(svc.list().schedules[0]!.retryAt).toBe(t.now + 10 * 60_000)

    await svc.tick()
    expect(t.prompts).toHaveLength(1)
    t.advance(10 * 60_000)
    await svc.tick()
    expect(t.prompts.map(([id]) => id)).toEqual(['s1', 's2'])
    expect(svc.list().runs[0]).toMatchObject({ retry: true, status: 'running' })
    t.finish('s2', 'error')
    // The second failure is the one reported, and there is no third try.
    expect(t.ended.map(([r]) => [r.status, r.retry])).toEqual([['error', true]])
    expect(svc.list().schedules[0]!.retryAt).toBeUndefined()
    svc.stop()
  })

  it('keeps test runs independent of the interval across restart', async () => {
    const t = setup()
    const svc = t.make()
    svc.start()
    const s = svc.saveSchedule({
      name: 'Test',
      prompt: 'p',
      trigger: { kind: 'every', minutes: 60 },
      target: NEW,
      retryOnFailure: true,
    })
    const next = s.nextRunAt
    t.advance(20 * 60_000)
    await svc.runNow(s.id)
    t.finish('s1', 'error')
    expect(s.nextRunAt).toBe(next)
    expect(s.lastRunAt).toBeUndefined()
    expect(s.retryAt).toBeUndefined()
    svc.stop()
    t.advance(50 * 60_000)
    const again = t.make()
    again.start()
    expect(again.list().schedules[0]!.nextRunAt).toBe(next! + 60 * 60_000)
    again.stop()
  })

  it('does not cancel a pending scheduled retry when a test finishes', async () => {
    const t = setup()
    const svc = t.make()
    svc.start()
    const s = svc.saveSchedule({
      name: 'Retry',
      prompt: 'p',
      trigger: { kind: 'every', minutes: 60 },
      target: NEW,
      retryOnFailure: true,
    })
    t.advance(60 * 60_000)
    await svc.tick()
    t.finish('s1', 'error')
    const retryAt = s.retryAt
    await svc.runNow(s.id)
    t.finish('s2')
    expect(s.retryAt).toBe(retryAt)
    t.advance(10 * 60_000)
    await svc.tick()
    expect(svc.list().runs[0]).toMatchObject({ retry: true, sessionId: 's3' })
    svc.stop()
  })

  it('retains the session link if starting the prompt fails', async () => {
    const t = setup()
    t.host.prompt = async () => {
      throw new Error('Prompt failed')
    }
    const svc = t.make()
    const s = svc.saveSchedule({
      name: 'Failed',
      prompt: 'p',
      trigger: { kind: 'every', minutes: 60 },
      target: NEW,
    })
    expect(await svc.runNow(s.id)).toMatchObject({ status: 'error', sessionId: 's1' })
  })

  it('skips one upcoming occurrence and persists it', async () => {
    const t = setup()
    const svc = t.make()
    svc.start()
    const s = svc.saveSchedule({
      name: 'Skip',
      prompt: 'p',
      trigger: { kind: 'every', minutes: 60 },
      target: NEW,
    })
    const first = s.nextRunAt!
    expect(svc.skipNext(s.id).nextRunAt).toBe(first + 60 * 60_000)
    svc.stop()
    const again = t.make()
    again.start()
    t.advance(60 * 60_000)
    await again.tick()
    expect(t.prompts).toHaveLength(0)
    t.advance(60 * 60_000)
    await again.tick()
    expect(t.prompts).toHaveLength(1)
    again.setPaused(s.id, true)
    expect(() => again.skipNext(s.id)).toThrow('No upcoming run')
    again.stop()
  })

  it('asks for a pull request, and alerts only as the schedule says', async () => {
    const t = setup()
    const svc = t.make()
    svc.start()
    const loud = svc.saveSchedule({
      name: 'PR',
      prompt: 'Bump deps',
      trigger: { kind: 'every', minutes: 60 },
      target: NEW,
      openPr: true,
      notify: 'failure',
    })
    await svc.runNow(loud.id)
    expect(t.prompts[0]![1]).toContain('open a pull request')
    expect(t.prompts[0]![1].startsWith('Bump deps')).toBe(true)
    t.finish('s1', 'done')
    expect(t.ended).toHaveLength(0)

    t.advance(60_000)
    const quiet = svc.saveSchedule({
      name: 'Quiet',
      prompt: 'q',
      trigger: { kind: 'every', minutes: 60 },
      target: NEW,
      notify: 'never',
    })
    await svc.runNow(quiet.id)
    t.finish('s2', 'error')
    expect(t.ended).toHaveLength(0)
    svc.stop()
  })

  it('refuses a time zone that does not exist', () => {
    const svc = setup().make()
    expect(() =>
      svc.saveSchedule({
        name: 'Z',
        prompt: 'p',
        trigger: { kind: 'cron', expr: '0 9 * * *', timezone: 'Mars/Olympus' },
        target: NEW,
      }),
    ).toThrow(/time zone/)
  })
})

describe('watch triggers', () => {
  const WATCH = { kind: 'watch' as const, glob: 'src/**/*.ts' }

  it('sets a baseline on the first scan and fires only when files change, naming them', async () => {
    let files = [{ path: 'src/a.ts', size: 1, mtimeMs: 1 }]
    const t = setup(undefined, async () => files)
    const svc = t.make()
    svc.start()
    const s = svc.saveSchedule({ name: 'Watch', prompt: 'run tests', trigger: WATCH, target: NEW })

    await svc.tick()
    expect(t.prompts).toHaveLength(0) // first scan only sets the baseline
    expect(svc.list().schedules[0]!.lastWatch?.digest).toBeTruthy()

    await svc.tick()
    expect(t.prompts).toHaveLength(0) // nothing changed

    files = [...files, { path: 'src/b.ts', size: 2, mtimeMs: 2 }]
    t.advance(6 * 60_000) // past the 5-minute debounce
    await svc.tick()
    expect(t.prompts).toHaveLength(1)
    expect(t.prompts[0]![1]).toContain('run tests')
    expect(t.prompts[0]![1]).toContain('src/b.ts')

    // Same state again: no fire.
    t.advance(60_000)
    await svc.tick()
    expect(t.prompts).toHaveLength(1)
    svc.stop()
  })

  it('waits out the debounce before firing again', async () => {
    let files = [{ path: 'src/a.ts', size: 1, mtimeMs: 1 }]
    const t = setup(undefined, async () => files)
    const svc = t.make()
    svc.start()
    svc.saveSchedule({
      name: 'W',
      prompt: 'p',
      trigger: { ...WATCH, debounceMinutes: 10 },
      target: NEW,
    })
    await svc.tick() // baseline
    files = [{ path: 'src/a.ts', size: 2, mtimeMs: 2 }]
    t.advance(2 * 60_000) // changed, but inside the 10-minute debounce
    await svc.tick()
    expect(t.prompts).toHaveLength(0)
    t.advance(9 * 60_000) // now past it; the change is still pending
    await svc.tick()
    expect(t.prompts).toHaveLength(1)
    svc.stop()
  })

  it('watches the session folder for a session target, and a watch trigger has no nextRunAt', async () => {
    let scanned: [string, string][] = []
    const t = setup(undefined, async (cwd: string, glob: string) => {
      scanned.push([cwd, glob])
      return [{ path: 'x.ts', size: 1, mtimeMs: 1 }]
    })
    const svc = t.make()
    svc.start()
    // A session target: the watched folder is the session's cwd.
    const s0 = await t.host.create(
      { instanceId: 'codex', cwd: '/project', title: 'x' },
      { schedule: { id: 'x', name: 'x' } },
    )
    const s = svc.saveSchedule({
      name: 'S',
      prompt: 'p',
      trigger: WATCH,
      target: { kind: 'session', sessionId: s0.sessionId },
    })
    expect(s.nextRunAt).toBeUndefined()
    await svc.tick()
    expect(scanned).toEqual([['/project', 'src/**/*.ts']])
    svc.stop()
  })

  it('persists the baseline across a restart, so a restart alone does not fire it', async () => {
    const files = [{ path: 'src/a.ts', size: 1, mtimeMs: 1 }]
    const scan = async () => files
    const t = setup(undefined, scan)
    const svc = t.make()
    svc.start()
    svc.saveSchedule({ name: 'W', prompt: 'p', trigger: WATCH, target: NEW })
    await svc.tick()
    svc.stop()

    // A new service over the same file, with the same files: no fire.
    const svc2 = t.make()
    svc2.start()
    await svc2.tick()
    expect(t.prompts).toHaveLength(0)
    svc2.stop()
  })

  it('preview explains that a watch trigger has no clock', () => {
    setup()
    const res = previewTrigger(WATCH, Date.now(), 3)
    expect(res.times).toEqual([])
    expect(res.error).toMatch(/files change/)
  })
})
