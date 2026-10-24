import path from 'node:path'
import { parseArgs, str } from './args.ts'
import { chooseAgent, chooseMode, chooseModel } from './agents.ts'
import { connect, connectAll, type Conn } from './connection.ts'
import { answerWaiting, EXIT_CODE, follow, Printer, startFrom } from './follow.ts'
import { allTargets, pickTargets, type HostTarget } from './hosts.ts'
import { readStdin, type Io } from './io.ts'
import {
  findSession,
  formatSessions,
  lastReply,
  phaseOf,
  sessionJson,
  shortId,
  undoableChanges,
  waitingOn,
  type Row,
} from './render.ts'

export interface Ctx {
  port: number
  io: Io
  /** The hosts this command may use; defaults to this machine plus the paired ones. */
  targets?: HostTarget[]
}

const targetsOf = (ctx: Ctx) => ctx.targets ?? allTargets(ctx.port)

const rowsOf = (conns: Conn[]): Row[] =>
  conns.flatMap((c) =>
    Object.values(c.state().sessions).map((view) => ({ host: c.target.name, view })),
  )

/** Connects to the hosts a command should look at, reporting the ones that cannot be reached. */
async function open(ctx: Ctx, hostFlag: string | undefined) {
  const targets = pickTargets(targetsOf(ctx), hostFlag)
  const { conns, failures } = await connectAll(targets)
  if (conns.length === 0) throw new Error(failures[0]?.error ?? 'No host to talk to.')
  for (const f of failures) ctx.io.err(`! ${f.target.name}: ${f.error}\n`)
  return conns
}

const closeAll = (conns: Conn[]) => conns.forEach((c) => c.close())

/** `beddcode ls [--host h] [--all] [--status s] [--json]` */
export async function lsCmd(args: string[], ctx: Ctx): Promise<number> {
  const { flags } = parseArgs(args, { bool: ['all', 'json'], string: ['host', 'status'] })
  const conns = await open(ctx, str(flags.host))
  try {
    let rows = rowsOf(conns)
    const status = str(flags.status)
    if (status) rows = rows.filter((r) => phaseOf(r.view) === status.replace('-', ' '))
    else if (!flags.all) rows = rows.filter((r) => !r.view.done)
    if (flags.json) {
      ctx.io.out(`${JSON.stringify(rows.map(sessionJson), null, 2)}\n`)
    } else {
      ctx.io.out(`${formatSessions(rows, Date.now(), process.stdout.columns || 100)}\n`)
    }
    return 0
  } finally {
    closeAll(conns)
  }
}

/** `beddcode run "prompt" [--agent a] [--model m] [--mode m] [--worktree] [--wait] [--json]` */
export async function runCmd(args: string[], ctx: Ctx, readInput = readStdin): Promise<number> {
  const { flags, rest } = parseArgs(args, {
    bool: ['worktree', 'wait', 'json', 'quiet', 'no-project', 'no-stdin'],
    string: ['agent', 'model', 'mode', 'effort', 'folder', 'title', 'host'],
  })
  let prompt = rest.join(' ').trim()
  const piped = flags['no-stdin'] ? null : await readInput()
  if (piped) prompt = prompt ? `${prompt}\n\n${piped.trimEnd()}\n` : piped.trim()
  if (!prompt) throw new Error('Say what to do: beddcode run "fix the failing test"')

  const [target] = pickTargets(targetsOf(ctx), str(flags.host) ?? 'local')
  if (!target) throw new Error('No host to talk to.')
  const projectless = flags['no-project'] === true
  if (!target.local && !projectless && !str(flags.folder)) {
    throw new Error(
      `${target.name} is another machine: give a folder on it with --folder <path>, or use --no-project.`,
    )
  }
  const folder = projectless ? undefined : path.resolve(str(flags.folder) ?? process.cwd())
  if (projectless && (flags.worktree || str(flags.folder))) {
    throw new Error('--no-project cannot be combined with --folder or --worktree')
  }

  const conn = await connect(target)
  try {
    const providers = await conn.request('providers.list', {})
    const agent = chooseAgent(providers, str(flags.agent))
    const mode = str(flags.mode)
    const model = str(flags.model)
    const { sessionId } = await conn.request('sessions.create', {
      instanceId: agent.id,
      cwd: target.local ? folder : str(flags.folder),
      projectless: projectless || undefined,
      title: str(flags.title),
      permissionMode: mode ? chooseMode(agent, mode) : undefined,
      model: model ? chooseModel(agent, model) : undefined,
      effort: str(flags.effort),
      workspace: flags.worktree ? { mode: 'worktree' } : undefined,
    })
    await conn.request('sessions.prompt', { sessionId, text: prompt })

    if (!flags.wait) {
      if (flags.json) {
        ctx.io.out(`${JSON.stringify({ host: target.name, sessionId, agent: agent.id })}\n`)
      } else {
        ctx.io.out(`${sessionId}\n`)
        ctx.io.err(
          `Started ${shortId(sessionId)} with ${agent.label}. Follow it: beddcode attach ${shortId(sessionId)}\n`,
        )
      }
      return 0
    }

    const printer = new Printer(
      ctx.io,
      flags.quiet === true || flags.json === true,
      flags.json === true,
    )
    const outcome = await follow(conn, sessionId, {
      io: ctx.io,
      printer,
      afterTurns: 0,
      interactive: ctx.io.interactive,
    })
    const view = conn.state().sessions[sessionId]
    if (flags.json && view) {
      ctx.io.out(
        `${JSON.stringify({
          host: target.name,
          sessionId,
          outcome,
          reply: lastReply(view),
          changedFiles: undoableChanges(view)?.files.length ?? 0,
        })}\n`,
      )
    }
    if (outcome === 'needs-you') {
      ctx.io.err(
        `The agent needs an answer. Run: beddcode attach ${shortId(sessionId)}  (or beddcode approve ${shortId(sessionId)})\n`,
      )
    }
    return EXIT_CODE[outcome]
  } finally {
    conn.close()
  }
}

async function session(args: string[], ctx: Ctx, flagSpec: Parameters<typeof parseArgs>[1] = {}) {
  const { flags, rest } = parseArgs(args, {
    ...flagSpec,
    string: [...(flagSpec.string ?? []), 'host'],
  })
  const query = rest[0]
  if (!query) throw new Error('Which session? Give its id, part of its title, or `last`.')
  const conns = await open(ctx, str(flags.host))
  try {
    const row = findSession(rowsOf(conns), query)
    const conn = conns.find((c) => c.target.name === row.host)!
    return { conns, conn, row, flags, rest: rest.slice(1) }
  } catch (err) {
    closeAll(conns)
    throw err
  }
}

/** `beddcode send <session> "message" [--queue]` */
export async function sendCmd(args: string[], ctx: Ctx, readInput = readStdin): Promise<number> {
  const s = await session(args, ctx, { bool: ['queue', 'no-stdin'] })
  try {
    let text = s.rest.join(' ').trim()
    const piped = s.flags['no-stdin'] ? null : await readInput()
    if (piped) text = text ? `${text}\n\n${piped.trimEnd()}\n` : piped.trim()
    if (!text) throw new Error('Say what to send: beddcode send <session> "also add tests"')
    const res = await s.conn.request('sessions.prompt', {
      sessionId: s.row.view.id,
      text,
      mode: s.flags.queue ? 'queue' : undefined,
    })
    ctx.io.err(
      `${res.state === 'started' ? 'Sent' : res.state === 'steered' ? 'Steered into the running turn' : 'Queued for the next turn'}.\n`,
    )
    return 0
  } finally {
    closeAll(s.conns)
  }
}

/** `beddcode stop <session>` */
export async function stopCmd(args: string[], ctx: Ctx): Promise<number> {
  const s = await session(args, ctx)
  try {
    await s.conn.request('sessions.interrupt', { sessionId: s.row.view.id })
    ctx.io.err(`Stopped ${shortId(s.row.view.id)}.\n`)
    return 0
  } finally {
    closeAll(s.conns)
  }
}

/** `beddcode approve <session> [allow|deny|<number>]` */
export async function approveCmd(args: string[], ctx: Ctx): Promise<number> {
  const s = await session(args, ctx)
  try {
    const waiting = waitingOn(s.row.view)
    if (!waiting) {
      ctx.io.err('Nothing is waiting on you in that session.\n')
      return 1
    }
    const choice = s.rest[0]?.toLowerCase()
    if (waiting.kind === 'approval' && choice) {
      const a = waiting.item
      const option =
        a.options[Number(choice) - 1] ??
        a.options.find(
          (o) => o.kind === choice || o.id === choice || o.label.toLowerCase() === choice,
        )
      if (!option) {
        throw new Error(
          `Choose allow, deny or a number: ${a.options.map((o, i) => `${i + 1}=${o.label}`).join(', ')}`,
        )
      }
      await s.conn.request('sessions.approve', {
        sessionId: s.row.view.id,
        requestId: a.requestId,
        optionId: option.id,
      })
      ctx.io.err(`${option.label}.\n`)
      return 0
    }
    if (!ctx.io.interactive) {
      throw new Error('Say which: beddcode approve <session> allow|deny (or run it in a terminal).')
    }
    await answerWaiting(s.conn, s.row.view.id, waiting, ctx.io)
    return 0
  } finally {
    closeAll(s.conns)
  }
}

/** `beddcode undo <session> [--yes]`: put back what the latest turn changed. */
export async function undoCmd(args: string[], ctx: Ctx): Promise<number> {
  const s = await session(args, ctx, { bool: ['yes'] })
  try {
    const changes = undoableChanges(s.row.view)
    if (!changes) {
      ctx.io.err('The latest turn changed nothing that can be undone.\n')
      return 1
    }
    const files = changes.files.map((f) => `  ${f.path}`).join('\n')
    ctx.io.err(
      `This puts ${changes.files.length} file(s) back as they were before the latest turn:\n${files}\n`,
    )
    if (!s.flags.yes) {
      if (!ctx.io.interactive) throw new Error('Add --yes to undo without being asked.')
      const answer = (await ctx.io.ask('Undo? [y/N] ')).toLowerCase()
      if (answer !== 'y' && answer !== 'yes') return 1
    }
    const res = await s.conn.request('sessions.undoTurn', {
      sessionId: s.row.view.id,
      after: changes.after,
    })
    ctx.io.err(`Restored ${res.restored} file(s).\n`)
    return 0
  } finally {
    closeAll(s.conns)
  }
}

/**
 * `beddcode attach <session>`: a live view. Answers approvals and questions as they come, and
 * anything typed meanwhile is sent to the agent (`/stop` interrupts, `/quit` leaves).
 */
export async function attachCmd(args: string[], ctx: Ctx): Promise<number> {
  const s = await session(args, ctx)
  const id = s.row.view.id
  try {
    const view = s.conn.state().sessions[id]!
    const printer = new Printer(ctx.io)
    ctx.io.err(`${view.title}  (${shortId(id)}, ${view.instanceId}, ${phaseOf(view)})\n`)
    const last = lastReply(view)
    if (last) {
      ctx.io.err('— latest reply —\n')
      printer.text(`${last}\n`)
    }
    const memo = startFrom(view)
    ctx.io.err('— live; type a message to send it, /stop to interrupt, /quit to leave —\n')

    const abort = new AbortController()
    const streaming = follow(s.conn, id, {
      io: ctx.io,
      printer,
      afterTurns: 0,
      interactive: ctx.io.interactive,
      forever: true,
      signal: abort.signal,
      memo,
    })
    // Typed lines go to the agent; the answering prompts read from the same input.
    if (ctx.io.interactive) {
      void (async () => {
        for (;;) {
          const line = await ctx.io.ask('')
          if (line === '/quit' || line === '/exit') return abort.abort()
          if (line === '/stop') await s.conn.request('sessions.interrupt', { sessionId: id })
          else if (line) await s.conn.request('sessions.prompt', { sessionId: id, text: line })
        }
      })().catch((err) => ctx.io.err(`${err instanceof Error ? err.message : err}\n`))
    }
    await streaming
    return 0
  } finally {
    closeAll(s.conns)
  }
}
