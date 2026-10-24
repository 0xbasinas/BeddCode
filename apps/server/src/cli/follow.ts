import type { SessionView } from '@beddcode/client-runtime/replica'
import type { Conn } from './connection.ts'
import type { Io } from './io.ts'
import { markSeen, newMemo, renderNew, waitingOn, type Memo, type Waiting } from './render.ts'

/** How a turn ended: the exit code of `beddcode run --wait` follows it. */
export type Outcome = 'done' | 'error' | 'cancelled' | 'needs-you'

export const EXIT_CODE: Record<Outcome, number> = {
  done: 0,
  error: 1,
  cancelled: 2,
  'needs-you': 3,
}

/** Tracks whether the last thing written ended a line, so activity never lands mid-sentence. */
export class Printer {
  private midLine = false
  constructor(
    private readonly io: Io,
    private readonly quiet = false,
    /** Leave the answer out (the caller prints it in another form, as JSON). */
    private readonly silentText = false,
  ) {}

  text(chunk: string) {
    if (!chunk || this.silentText) return
    this.io.out(chunk)
    this.midLine = !chunk.endsWith('\n')
  }

  activity(line: string) {
    if (this.quiet) return
    if (this.midLine) {
      this.io.out('\n')
      this.midLine = false
    }
    this.io.err(`${line}\n`)
  }

  end() {
    if (this.midLine) this.io.out('\n')
    this.midLine = false
  }
}

const labelOf = (kind: 'allow' | 'deny' | 'other') =>
  kind === 'allow' ? 'allow' : kind === 'deny' ? 'deny' : 'other'

/** Asks the person what the agent is waiting on, and sends the answer. */
export async function answerWaiting(
  conn: Conn,
  sessionId: string,
  waiting: Waiting,
  io: Io,
): Promise<void> {
  if (waiting.kind === 'approval') {
    const a = waiting.item
    io.err(`\n? ${a.title}\n`)
    if (a.detail) io.err(`  ${a.detail.split('\n').join('\n  ')}\n`)
    if (a.plan) io.err(`${a.plan}\n`)
    a.options.forEach((o, i) => io.err(`  ${i + 1}) ${o.label} (${labelOf(o.kind)})\n`))
    for (;;) {
      const answer = (await io.ask('Choose: ')).toLowerCase()
      const option =
        a.options[Number(answer) - 1] ??
        a.options.find((o) => o.label.toLowerCase() === answer || o.id === answer) ??
        a.options.find((o) => o.kind === answer)
      if (option) {
        await conn.request('sessions.approve', {
          sessionId,
          requestId: a.requestId,
          optionId: option.id,
        })
        return
      }
      io.err('Type a number from the list.\n')
    }
  }

  const q = waiting.item
  const answers: Record<string, string[]> = {}
  for (const question of q.questions) {
    io.err(`\n? ${question.header ? `${question.header}: ` : ''}${question.question}\n`)
    const options = question.options ?? []
    options.forEach((o, i) =>
      io.err(`  ${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ''}\n`),
    )
    const hint = options.length
      ? question.multiSelect
        ? 'Numbers separated by commas'
        : 'A number'
      : 'Your answer'
    const raw = await io.ask(`${hint}${question.allowOther && options.length ? ' or text' : ''}: `)
    const picked = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => (options[Number(p) - 1] ? options[Number(p) - 1]!.label : p))
    answers[question.id] = question.multiSelect ? picked : [picked.join(', ')]
  }
  await conn.request('sessions.answer', { sessionId, requestId: q.requestId, answers })
}

export interface FollowOptions {
  io: Io
  printer: Printer
  /** Finish when a turn ends after this many were completed (a `run` waits for its own). */
  afterTurns: number
  /** Ask about approvals and questions here; otherwise stop and report `needs-you`. */
  interactive: boolean
  /** Keep following after the turn ends (attach); stops only when `signal` aborts. */
  forever?: boolean
  signal?: AbortSignal
  memo?: Memo
}

const outcomeOf = (view: SessionView): Outcome =>
  view.status === 'failed' || view.lastTurnReason === 'error'
    ? 'error'
    : view.lastTurnReason === 'cancelled'
      ? 'cancelled'
      : 'done'

/** Prints a session's new output as it arrives, until its turn ends (or forever). */
export function follow(conn: Conn, sessionId: string, options: FollowOptions): Promise<Outcome> {
  const memo = options.memo ?? newMemo()
  return new Promise((resolve) => {
    let handling = false
    let finished = false
    const finish = (outcome: Outcome) => {
      if (finished) return
      finished = true
      unsubscribe()
      options.printer.end()
      resolve(outcome)
    }
    const check = async () => {
      if (finished) return
      const view = conn.state().sessions[sessionId]
      // A session that was just created reaches us as an event a moment later.
      if (!view) return
      const out = renderNew(view, memo)
      out.activity.forEach((l) => options.printer.activity(l))
      out.text.forEach((t) => options.printer.text(t))

      const waiting = view.status === 'needs-you' ? waitingOn(view) : null
      if (waiting) {
        if (!options.interactive) return finish('needs-you')
        if (handling) return
        handling = true
        options.printer.end()
        try {
          await answerWaiting(conn, sessionId, waiting, options.io)
        } finally {
          handling = false
        }
        return void check()
      }
      if (options.forever) return
      if (view.status === 'failed') return finish('error')
      if (view.status !== 'running' && view.completedTurns > options.afterTurns) {
        finish(outcomeOf(view))
      }
    }
    const unsubscribe = conn.onChange(() => void check())
    options.signal?.addEventListener('abort', () => finish('cancelled'))
    void check()
  })
}

/** Marks what a session already holds as shown, so following starts from now. */
export function startFrom(view: SessionView): Memo {
  const memo = newMemo()
  markSeen(view, memo)
  return memo
}
