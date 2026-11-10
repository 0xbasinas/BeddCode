import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { quarantineFile, writeFileAtomic } from '@beddcode/shared'
import {
  Schedule,
  ScheduleRun,
  type RpcParams,
  type ScheduleInput,
  type StoredEvent,
} from '@beddcode/contracts'
import type { Logger } from '@beddcode/shared'
import type { SessionOrigin } from '../sessions/sessionManager.ts'
import { isTimeZone, nextRun, parseCron } from './cron.ts'
import { digest } from './digest.ts'
import { filesDigest, globToRegExp, scanGlob, type WatchedFile } from './watchGlob.ts'

/** Runs kept per schedule, newest first. */
const RUNS_KEPT = 20
const TICK_MS = 15_000
/** How long a failed run waits before its one retry. */
const RETRY_MS = 10 * 60_000
/** Added to the prompt when a run should hand its work over as a pull request. */
const PR_INSTRUCTION =
  '\n\nWhen you are done, make your changes on a new branch (never on main) and open a pull request with them.'

export interface ScheduleHost {
  create(
    params: RpcParams<'sessions.create'>,
    origin: SessionOrigin,
  ): Promise<{ sessionId: string }>
  prompt(sessionId: string, text: string): Promise<unknown>
  isBusy(sessionId: string): boolean
  readSession(sessionId: string): StoredEvent[]
  subscribe(listener: (stored: StoredEvent) => void): () => void
}

export interface ScheduleServiceOptions {
  file: string
  host: ScheduleHost
  log: Logger
  /** Told when a run ends, for alerts. */
  onRunEnded?: (run: ScheduleRun, schedule: Schedule) => void
  now?: () => number
  tickMs?: number
  /** Lists the files a watch trigger matches; injectable for tests. Defaults to scanning the disk. */
  scan?: (cwd: string, glob: string) => Promise<WatchedFile[]>
}

/** How long after a watch fire the same schedule waits before it can fire again. */
const DEFAULT_WATCH_DEBOUNCE_MS = 5 * 60_000
/** How many changed files a watch fire names in its prompt. */
const WATCH_PROMPT_FILES = 20

/**
 * Prompts the host sends on a timer, whether or not any app is open. A run starts a fresh session
 * or messages an existing one; a run is skipped while the previous one is still going.
 */
export class ScheduleService {
  private schedules: Schedule[] = []
  private runs: ScheduleRun[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private unsubscribe: (() => void) | undefined
  private readonly firing = new Set<string>()
  private readonly now: () => number

  constructor(private readonly options: ScheduleServiceOptions) {
    this.now = options.now ?? Date.now
    this.load()
  }

  private load() {
    try {
      const data = JSON.parse(readFileSync(this.options.file, 'utf8')) as {
        schedules?: unknown[]
        runs?: unknown[]
      }
      this.schedules = (data.schedules ?? []).flatMap((s) => {
        const parsed = Schedule.safeParse(s)
        return parsed.success ? [parsed.data] : []
      })
      this.runs = (data.runs ?? []).flatMap((r) => {
        const parsed = ScheduleRun.safeParse(r)
        return parsed.success ? [parsed.data] : []
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Keep the damaged file rather than overwrite it at the next save.
        const kept = quarantineFile(this.options.file)
        this.options.log.warn(
          `could not read ${this.options.file}${kept ? `; kept as ${kept}` : ''}`,
          err,
        )
      }
    }
  }

  private save() {
    writeFileAtomic(
      this.options.file,
      JSON.stringify({ version: 1, schedules: this.schedules, runs: this.runs }, null, 2),
    )
  }

  /** Starts the timer and follows the sessions runs work in. */
  start() {
    this.unsubscribe = this.options.host.subscribe((stored) => this.onEvent(stored))
    // Runs that were going when the host stopped: settle them from what their session says now.
    for (const run of this.runs.filter((r) => r.status === 'running')) this.settleFromLog(run)
    // Missed fires while the host was off are not made up; each schedule fires next from now.
    const now = this.now()
    for (const s of this.schedules) {
      if (!s.paused && s.nextRunAt !== undefined && s.nextRunAt < now)
        s.nextRunAt = this.computeNext(s, now)
    }
    this.save()
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? TICK_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.unsubscribe?.()
  }

  /** A schedule's run is about this session's latest turn (so the schedule sends the alert). */
  coversTurn(sessionId: string): boolean {
    const now = this.now()
    return this.runs.some(
      (r) =>
        r.sessionId === sessionId &&
        (r.status === 'running' || (r.endedAt !== undefined && now - r.endedAt < 10_000)),
    )
  }

  list() {
    return { schedules: this.schedules, runs: this.runs }
  }

  private computeNext(s: Pick<Schedule, 'trigger' | 'lastRunAt' | 'createdAt'>, after: number) {
    try {
      return nextRun(
        s.trigger,
        after,
        s.trigger.kind === 'every' ? (s.lastRunAt ?? s.createdAt) : undefined,
      )
    } catch {
      return undefined
    }
  }

  saveSchedule(input: ScheduleInput): Schedule {
    if (input.trigger.kind === 'cron') {
      parseCron(input.trigger.expr)
      if (input.trigger.timezone && !isTimeZone(input.trigger.timezone))
        throw new Error(`"${input.trigger.timezone}" is not a time zone`)
    }
    if (input.trigger.kind === 'watch') {
      // Fails loudly on a glob that can never compile; also rejects an empty one.
      globToRegExp(input.trigger.glob)
    }
    if (
      input.target.kind === 'session' &&
      !digest(this.options.host.readSession(input.target.sessionId))
    )
      throw new Error('That session no longer exists')
    const existing = input.id ? this.schedules.find((s) => s.id === input.id) : undefined
    if (input.id && !existing) throw new Error('No such schedule')
    const now = this.now()
    const schedule: Schedule = {
      ...input,
      id: existing?.id ?? randomUUID(),
      paused: input.paused ?? existing?.paused ?? false,
      createdAt: existing?.createdAt ?? now,
      lastRunAt: existing?.lastRunAt,
      retryAt: existing?.retryAt,
    }
    // A changed timer starts counting again from now.
    const timerChanged = JSON.stringify(existing?.trigger) !== JSON.stringify(input.trigger)
    schedule.nextRunAt = schedule.paused
      ? undefined
      : timerChanged
        ? nextRun(schedule.trigger, now, now)
        : (existing?.nextRunAt ?? this.computeNext(schedule, now))
    this.schedules = existing
      ? this.schedules.map((s) => (s.id === schedule.id ? schedule : s))
      : [...this.schedules, schedule]
    this.save()
    return schedule
  }

  remove(id: string): boolean {
    const before = this.schedules.length
    this.schedules = this.schedules.filter((s) => s.id !== id)
    this.runs = this.runs.filter((r) => r.scheduleId !== id || r.status === 'running')
    this.save()
    return this.schedules.length < before
  }

  setPaused(id: string, paused: boolean): Schedule {
    const s = this.require(id)
    s.paused = paused
    if (paused) s.retryAt = undefined
    s.nextRunAt = paused ? undefined : nextRun(s.trigger, this.now(), this.now())
    this.save()
    return s
  }

  private require(id: string): Schedule {
    const s = this.schedules.find((x) => x.id === id)
    if (!s) throw new Error('No such schedule')
    return s
  }

  runNow(id: string): Promise<ScheduleRun> {
    return this.fire(this.require(id), true)
  }

  /** Skip exactly the next scheduled occurrence, without affecting pending retries. */
  skipNext(id: string): Schedule {
    const s = this.require(id)
    if (s.paused || s.nextRunAt === undefined) throw new Error('No upcoming run to skip')
    const skippedAt = s.nextRunAt
    s.nextRunAt = nextRun(s.trigger, skippedAt, skippedAt)
    this.save()
    return s
  }

  /** Fires every schedule that is due. */
  async tick() {
    const now = this.now()
    const due = this.schedules.filter(
      (s) => !s.paused && s.nextRunAt !== undefined && s.nextRunAt <= now,
    )
    for (const s of due) {
      s.nextRunAt = nextRun(s.trigger, now, now)
      await this.fire(s, false).catch((err) => this.options.log.warn(`schedule ${s.name}`, err))
    }
    // Failed runs waiting for their second try.
    for (const s of this.schedules.filter(
      (x) => !x.paused && x.retryAt !== undefined && x.retryAt <= now && !due.includes(x),
    )) {
      s.retryAt = undefined
      await this.fire(s, false, true).catch((err) =>
        this.options.log.warn(`schedule ${s.name}`, err),
      )
    }
    // Watch triggers fire on file changes, not on the clock.
    for (const s of this.schedules.filter((x) => !x.paused && x.trigger.kind === 'watch')) {
      await this.tickWatch(s).catch((err) => this.options.log.warn(`schedule ${s.name}`, err))
    }
  }

  /** The folder a watch trigger watches: the target's own, or its session's. */
  private watchCwd(s: Schedule): string | undefined {
    if (s.target.kind === 'new') return s.target.cwd
    const d = digest(this.options.host.readSession(s.target.sessionId))
    return d?.cwd
  }

  /**
   * Fires a watch schedule when its glob starts matching something new. The first scan only sets
   * the baseline, so starting the host does not fire every watch schedule at once.
   */
  private async tickWatch(s: Schedule) {
    if (s.trigger.kind !== 'watch') return
    const cwd = this.watchCwd(s)
    if (!cwd) return
    const scan = this.options.scan ?? scanGlob
    const files = await scan(cwd, s.trigger.glob)
    const digestNow = filesDigest(files)
    const now = this.now()
    const last = s.lastWatch
    if (!last) {
      s.lastWatch = { digest: digestNow, at: now, files: files.map((f) => f.path).slice(0, 100) }
      this.save()
      return
    }
    if (last.digest === digestNow) return
    const debounce = (s.trigger.debounceMinutes ?? 5) * 60_000 || DEFAULT_WATCH_DEBOUNCE_MS
    if (now - last.at < debounce) return
    const before = new Map((last.files ?? []).map((p) => [p, true]))
    const changed = files.filter((f) => !before.has(f.path))
    const names = (changed.length > 0 ? changed : files)
      .map((f) => f.path)
      .slice(0, WATCH_PROMPT_FILES)
    const extra =
      names.length > 0 ? `\n\nChanged files:\n${names.map((n) => `- ${n}`).join('\n')}` : ''
    s.lastWatch = { digest: digestNow, at: now, files: files.map((f) => f.path).slice(0, 100) }
    this.save()
    await this.fire(s, false, false, extra)
  }

  /** Tells the alerts a run ended, unless it failed and is about to be tried again. */
  private ended(run: ScheduleRun, schedule: Schedule) {
    // A test run must not create, cancel, or postpone a scheduled retry.
    if (run.manual) {
      const notify = schedule.notify ?? 'always'
      if (notify !== 'never' && (notify !== 'failure' || run.status !== 'done'))
        this.options.onRunEnded?.(run, schedule)
      return
    }
    if (run.status === 'error' && schedule.retryOnFailure && !run.retry && !schedule.paused) {
      schedule.retryAt = this.now() + RETRY_MS
      this.save()
      return
    }
    schedule.retryAt = undefined
    const notify = schedule.notify ?? 'always'
    if (notify === 'never' || (notify === 'failure' && run.status === 'done')) return
    this.options.onRunEnded?.(run, schedule)
  }

  private record(run: ScheduleRun) {
    this.runs = [run, ...this.runs.filter((r) => r.id !== run.id)]
    // Keep the newest few per schedule.
    const counts = new Map<string, number>()
    this.runs = this.runs.filter((r) => {
      const n = (counts.get(r.scheduleId) ?? 0) + 1
      counts.set(r.scheduleId, n)
      return n <= RUNS_KEPT || r.status === 'running'
    })
    this.save()
  }

  private async fire(
    schedule: Schedule,
    manual: boolean,
    retry = false,
    extraPrompt = '',
  ): Promise<ScheduleRun> {
    const now = this.now()
    const base = {
      id: randomUUID(),
      scheduleId: schedule.id,
      startedAt: now,
      manual: manual || undefined,
      retry: retry || undefined,
    }
    const skip = (note: string) => {
      const run: ScheduleRun = { ...base, status: 'skipped', endedAt: now, note }
      this.record(run)
      return run
    }
    if (
      this.firing.has(schedule.id) ||
      this.runs.some((r) => r.scheduleId === schedule.id && r.status === 'running')
    )
      return skip('The previous run was still going')
    const target = schedule.target
    if (target.kind === 'session' && this.options.host.isBusy(target.sessionId))
      return skip('The session was busy')

    this.firing.add(schedule.id)
    if (!manual && !retry) schedule.lastRunAt = now
    let sessionId: string | undefined
    try {
      if (target.kind === 'new') {
        ;({ sessionId } = await this.options.host.create(
          {
            instanceId: target.instanceId,
            cwd: target.projectless ? undefined : target.cwd,
            projectless: target.projectless,
            permissionMode: target.permissionMode,
            model: target.model,
            effort: target.effort,
            title: schedule.name,
            workspace: target.worktree ? { mode: 'worktree' } : undefined,
          },
          { schedule: { id: schedule.id, name: schedule.name } },
        ))
      } else {
        if (!digest(this.options.host.readSession(target.sessionId)))
          throw new Error('The session no longer exists')
        sessionId = target.sessionId
      }
      const run: ScheduleRun = { ...base, status: 'running', sessionId }
      this.record(run)
      const prompt = schedule.prompt + extraPrompt
      await this.options.host.prompt(sessionId, schedule.openPr ? prompt + PR_INSTRUCTION : prompt)
      return run
    } catch (err) {
      const run: ScheduleRun = {
        ...base,
        status: 'error',
        endedAt: this.now(),
        sessionId,
        note: err instanceof Error ? err.message : String(err),
      }
      this.record(run)
      this.ended(run, schedule)
      return run
    } finally {
      this.firing.delete(schedule.id)
      this.save()
    }
  }

  private onEvent(stored: StoredEvent) {
    const { event } = stored
    if (event.type !== 'turn.completed') return
    const run = this.runs.find((r) => r.status === 'running' && r.sessionId === event.sessionId)
    if (run) this.finish(run, event.reason === 'done' ? 'done' : event.reason, event.message)
  }

  private settleFromLog(run: ScheduleRun) {
    if (!run.sessionId) return this.finish(run, 'error', 'Never started')
    const d = digest(this.options.host.readSession(run.sessionId))
    if (!d) return this.finish(run, 'error', 'The session is gone')
    if (d.status === 'idle') this.finish(run, 'done')
    else if (d.status === 'error' || d.status === 'cancelled')
      this.finish(run, d.status, d.lastError)
  }

  private finish(run: ScheduleRun, status: 'done' | 'error' | 'cancelled', note?: string) {
    const ended: ScheduleRun = { ...run, status, endedAt: this.now(), ...(note ? { note } : {}) }
    this.record(ended)
    const schedule = this.schedules.find((s) => s.id === run.scheduleId)
    if (schedule) this.ended(ended, schedule)
  }
}
