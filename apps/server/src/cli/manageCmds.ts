import path from 'node:path'
import type { Schedule, ScheduleInput, ScheduleRun, ScheduleTrigger } from '@beddcode/contracts'
import { chooseAgent, chooseMode, chooseModel } from './agents.ts'
import { parseArgs, str } from './args.ts'
import { connect, type Conn } from './connection.ts'
import { fetchHealth } from './health.ts'
import { allTargets, pickTargets } from './hosts.ts'
import { age, findSession, shortId } from './render.ts'
import { openApp } from './open.ts'
import type { Ctx } from './sessionCmds.ts'

/** Runs `fn` on one host: the one named by `--host`, else this machine's. */
async function withHost<T>(
  ctx: Ctx,
  host: string | undefined,
  fn: (conn: Conn) => Promise<T>,
): Promise<T> {
  const [target] = pickTargets(ctx.targets ?? allTargets(ctx.port), host ?? 'local')
  const conn = await connect(target!)
  try {
    return await fn(conn)
  } finally {
    conn.close()
  }
}

const when = (ms: number | undefined, now = Date.now()) =>
  ms === undefined ? '-' : ms > now ? `in ${age(now, ms)}` : `${age(ms, now)} ago`

// --- schedules -------------------------------------------------------------------------------

/** `every 30m`, `every 2h`, `every 1d`, or a five-field cron expression. */
export function parseTrigger(text: string): ScheduleTrigger {
  const every = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i.exec(text.trim())
  if (every) {
    const n = Number(every[1])
    const unit = every[2]![0]!.toLowerCase()
    const minutes = unit === 'm' ? n : unit === 'h' ? n * 60 : n * 1440
    if (minutes < 1 || minutes > 10_080) {
      throw new Error('A schedule can repeat every 1 minute to 7 days')
    }
    return { kind: 'every', minutes }
  }
  const fields = text.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`"${text}" is neither "every 30m" nor a five-field cron like "0 9 * * 1-5"`)
  }
  return { kind: 'cron', expr: fields.join(' ') }
}

const triggerText = (t: ScheduleTrigger) =>
  t.kind === 'cron'
    ? t.expr
    : t.minutes % 1440 === 0
      ? `every ${t.minutes / 1440}d`
      : t.minutes % 60 === 0
        ? `every ${t.minutes / 60}h`
        : `every ${t.minutes}m`

export function formatSchedules(schedules: Schedule[], now = Date.now()): string {
  if (schedules.length === 0)
    return 'No schedules. Add one: beddcode schedule add "0 9 * * 1-5" "triage"'
  const rows = schedules.map((s) => [
    shortId(s.id),
    s.paused ? 'paused' : 'active',
    triggerText(s.trigger),
    s.paused ? '-' : when(s.nextRunAt, now),
    when(s.lastRunAt, now),
    s.name,
  ])
  const head = ['ID', 'STATE', 'WHEN', 'NEXT', 'LAST', 'NAME']
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const line = (r: string[]) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd()
  return [line(head), ...rows.map(line)].join('\n')
}

export function formatRuns(runs: ScheduleRun[], schedules: Schedule[], now = Date.now()): string {
  if (runs.length === 0) return 'No runs yet.'
  const names = new Map(schedules.map((s) => [s.id, s.name]))
  return [...runs]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(
      (r) =>
        `${shortId(r.id)}  ${r.status.padEnd(9)} ${when(r.startedAt, now).padEnd(10)} ${names.get(r.scheduleId) ?? r.scheduleId}${r.sessionId ? `  (session ${shortId(r.sessionId)})` : ''}${r.note ? `  ${r.note}` : ''}`,
    )
    .join('\n')
}

export function findSchedule(schedules: Schedule[], query: string | undefined): Schedule {
  if (!query) throw new Error('Which schedule? Give its id or name (see `beddcode schedule ls`).')
  const q = query.toLowerCase()
  const pool = schedules.filter((s) => s.id === query || s.id.toLowerCase().startsWith(q))
  const named = schedules.filter((s) => s.name.toLowerCase() === q)
  const found =
    pool.length > 0
      ? pool
      : named.length > 0
        ? named
        : schedules.filter((s) => s.name.toLowerCase().includes(q))
  if (found.length === 1) return found[0]!
  if (found.length === 0) throw new Error(`No schedule matches "${query}".`)
  throw new Error(`"${query}" matches ${found.length} schedules; use more of its id.`)
}

/**
 * `beddcode schedule`: prompts the host runs on a timer, with every app closed.
 *   ls | runs | add "<when>" "<prompt>" | run <s> | pause <s> | resume <s> | rm <s> | preview "<when>"
 */
export async function scheduleCmd(args: string[], ctx: Ctx): Promise<number> {
  const { flags, rest } = parseArgs(args, {
    bool: ['worktree', 'no-project', 'json'],
    string: ['host', 'name', 'agent', 'model', 'mode', 'folder', 'session', 'count'],
  })
  const [action = 'ls', ...more] = rest
  return withHost(ctx, str(flags.host), async (conn) => {
    const list = () => conn.request('schedules.list', {})

    if (action === 'ls' || action === 'runs') {
      const { schedules, runs } = await list()
      if (flags.json) {
        ctx.io.out(`${JSON.stringify(action === 'ls' ? schedules : runs, null, 2)}\n`)
      } else {
        ctx.io.out(
          `${action === 'ls' ? formatSchedules(schedules) : formatRuns(runs, schedules)}\n`,
        )
      }
      return 0
    }

    if (action === 'preview') {
      const trigger = parseTrigger(more.join(' '))
      const res = await conn.request('schedules.preview', {
        trigger,
        count: flags.count ? Number(flags.count) : 5,
      })
      if (res.error) throw new Error(res.error)
      res.times.forEach((t) => ctx.io.out(`${new Date(t).toLocaleString()}\n`))
      return 0
    }

    if (action === 'add') {
      const [when, ...promptWords] = more
      const prompt = promptWords.join(' ').trim()
      if (!when || !prompt) {
        throw new Error('Usage: beddcode schedule add "0 9 * * 1-5" "triage new issues" [--name n]')
      }
      let target: ScheduleInput['target']
      if (str(flags.session)) {
        // A heartbeat: the same prompt, sent to a session that already exists, on every tick.
        const rows = Object.values(conn.state().sessions).map((view) => ({
          host: conn.target.name,
          view,
        }))
        target = { kind: 'session', sessionId: findSession(rows, str(flags.session)!).view.id }
      } else {
        const providers = await conn.request('providers.list', {})
        const agent = chooseAgent(providers, str(flags.agent))
        const mode = str(flags.mode)
        const model = str(flags.model)
        const projectless = flags['no-project'] === true
        target = {
          kind: 'new',
          instanceId: agent.id,
          cwd: projectless
            ? undefined
            : conn.target.local
              ? path.resolve(str(flags.folder) ?? process.cwd())
              : str(flags.folder),
          projectless: projectless || undefined,
          permissionMode: mode ? chooseMode(agent, mode) : undefined,
          model: model ? chooseModel(agent, model) : undefined,
          worktree: flags.worktree ? true : undefined,
        }
        if (!conn.target.local && !projectless && !str(flags.folder)) {
          throw new Error(
            `${conn.target.name} is another machine: give --folder <path> there, or --no-project.`,
          )
        }
      }
      const saved = await conn.request('schedules.save', {
        name: str(flags.name) ?? prompt.slice(0, 40),
        prompt,
        trigger: parseTrigger(when),
        target,
      })
      ctx.io.err(`Scheduled "${saved.name}" (${shortId(saved.id)}), next ${when_(saved)}.\n`)
      return 0
    }

    const { schedules } = await list()
    const s = findSchedule(schedules, more[0])
    if (action === 'run') {
      const run = await conn.request('schedules.runNow', { id: s.id })
      ctx.io.err(
        run.status === 'skipped'
          ? `Skipped: ${run.note ?? 'the previous run is still going'}.\n`
          : `Started${run.sessionId ? ` session ${shortId(run.sessionId)}` : ''}.\n`,
      )
      return run.status === 'skipped' ? 1 : 0
    }
    if (action === 'pause' || action === 'resume') {
      await conn.request('schedules.setPaused', { id: s.id, paused: action === 'pause' })
      ctx.io.err(`${action === 'pause' ? 'Paused' : 'Resumed'} "${s.name}".\n`)
      return 0
    }
    if (action === 'rm') {
      await conn.request('schedules.remove', { id: s.id })
      ctx.io.err(`Removed "${s.name}".\n`)
      return 0
    }
    throw new Error(
      `Unknown: beddcode schedule ${action}. Try ls, runs, add, run, pause, resume, rm.`,
    )
  })
}

const when_ = (s: Schedule) => (s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : 'never')

// --- projects --------------------------------------------------------------------------------

/** `beddcode projects [ls | add [folder] | rm <folder>]` */
export async function projectsCmd(args: string[], ctx: Ctx): Promise<number> {
  const { flags, rest } = parseArgs(args, { bool: ['json'], string: ['host'] })
  const [action = 'ls', folder] = rest
  return withHost(ctx, str(flags.host), async (conn) => {
    if (action === 'ls') {
      const projects = await conn.request('projects.list', {})
      if (flags.json) ctx.io.out(`${JSON.stringify(projects, null, 2)}\n`)
      else if (projects.length === 0) ctx.io.out('No projects. Add one: beddcode projects add .\n')
      else
        projects.forEach((p) => ctx.io.out(`${p.name.padEnd(24)} ${p.branch ?? '-'}  ${p.path}\n`))
      return 0
    }
    if (action === 'add' || action === 'rm') {
      const target = conn.target.local ? path.resolve(folder ?? '.') : folder
      if (!target)
        throw new Error(`${conn.target.name} is another machine: give the folder's path there.`)
      if (action === 'add') {
        const project = await conn.request('projects.add', { path: target })
        ctx.io.err(`Added ${project.name} (${project.path}).\n`)
      } else {
        const res = await conn.request('projects.remove', { path: target })
        ctx.io.err(res.removed ? `Removed ${target}.\n` : `${target} was not a project.\n`)
        return res.removed ? 0 : 1
      }
      return 0
    }
    throw new Error(`Unknown: beddcode projects ${action}. Try ls, add or rm.`)
  })
}

/** `beddcode open [folder]`: start the app, and add the folder as a project first when given. */
export async function openCmd(args: string[], ctx: Ctx): Promise<number> {
  const { rest } = parseArgs(args)
  const folder = rest[0]
  const code = openApp()
  if (code !== 0 || !folder) return code
  // The app starts its own host; give it a moment to come up before adding the folder.
  for (let i = 0; i < 40 && !(await fetchHealth(ctx.port)); i++) {
    await new Promise((r) => setTimeout(r, 750))
  }
  return projectsCmd(['add', folder], ctx)
}

// --- alerts, devices -------------------------------------------------------------------------

/** `beddcode alert test | ls | ntfy <url|off>` */
export async function alertCmd(args: string[], ctx: Ctx): Promise<number> {
  const { flags, rest } = parseArgs(args, { string: ['host'] })
  const [action = 'test', value] = rest
  return withHost(ctx, str(flags.host), async (conn) => {
    if (action === 'test') {
      const sent = await conn.request('alerts.test', {})
      if (sent.deliveries.length === 0) {
        ctx.io.err('Nothing to send to: no phone has registered and no ntfy topic is set.\n')
        return 1
      }
      sent.deliveries.forEach((d) =>
        ctx.io.out(`${d.ok ? '✓' : '✗'} ${d.to}${d.error ? `  ${d.error}` : ''}\n`),
      )
      return sent.deliveries.every((d) => d.ok) ? 0 : 1
    }
    if (action === 'ls') {
      const { settings, devices, recent } = await conn.request('alerts.settings', {})
      ctx.io.out(`ntfy: ${settings.ntfyUrl ?? 'not set'}\n`)
      ctx.io.out(
        `phones: ${devices.length === 0 ? 'none' : devices.map((d) => d.deviceName ?? d.tokenTail).join(', ')}\n`,
      )
      recent
        .slice(-10)
        .forEach((a) =>
          ctx.io.out(`${new Date(a.at).toLocaleTimeString()}  ${a.kind.padEnd(9)} ${a.title}\n`),
        )
      return 0
    }
    if (action === 'ntfy') {
      if (!value)
        throw new Error('Usage: beddcode alert ntfy https://ntfy.sh/your-topic (or "off")')
      await conn.request('alerts.setSettings', { ntfyUrl: value === 'off' ? null : value })
      ctx.io.err(
        value === 'off' ? 'ntfy is off.\n' : `ntfy topic set. Check it: beddcode alert test\n`,
      )
      return 0
    }
    throw new Error(`Unknown: beddcode alert ${action}. Try test, ls or ntfy.`)
  })
}

/** `beddcode devices`, `beddcode revoke <device>`: the machines paired with this host. */
export async function devicesCmd(args: string[], ctx: Ctx, revoke = false): Promise<number> {
  const { flags, rest } = parseArgs(args, { bool: ['json'], string: ['host'] })
  return withHost(ctx, str(flags.host), async (conn) => {
    const devices = await conn.request('devices.list', {})
    if (!revoke) {
      if (flags.json) ctx.io.out(`${JSON.stringify(devices, null, 2)}\n`)
      else if (devices.length === 0) ctx.io.out('No paired devices.\n')
      else {
        devices.forEach((d) =>
          ctx.io.out(
            `${shortId(d.id)}  ${d.name.padEnd(32)} last used ${d.lastUsedAt ? when(d.lastUsedAt) : 'never'}\n`,
          ),
        )
      }
      return 0
    }
    const query = rest[0]?.toLowerCase()
    if (!query) throw new Error('Which device? See `beddcode devices`.')
    const found = devices.filter(
      (d) => d.id.toLowerCase().startsWith(query) || d.name.toLowerCase() === query,
    )
    if (found.length !== 1) {
      throw new Error(
        found.length === 0
          ? `No device matches "${rest[0]}".`
          : `"${rest[0]}" matches ${found.length} devices; use more of its id.`,
      )
    }
    await conn.request('devices.revoke', { id: found[0]!.id })
    ctx.io.err(`Revoked ${found[0]!.name}. Its token stops working now.\n`)
    return 0
  })
}
