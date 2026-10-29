import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { createLogger } from '@beddcode/shared'
import { GrokSession, type SpawnFn } from './session.ts'

const log = createLogger('test', 'error')

/** A stand-in for one `grok -p` process: the test writes its stdout and then ends it. */
function fakeProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    pid: number
    exitCode: number | null
    kill: (signal?: string) => boolean
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 1234
  child.exitCode = null
  const end = (code: number | null, signal: string | null = null) => {
    child.exitCode = code ?? 130
    child.stdout.end()
    queueMicrotask(() => child.emit('close', code, signal))
  }
  child.kill = () => {
    queueMicrotask(() => end(null, 'SIGINT'))
    return true
  }
  return {
    child,
    say: (line: unknown) => child.stdout.write(JSON.stringify(line) + '\n'),
    raw: (text: string) => child.stdout.write(text),
    finish: end,
    stderr: (text: string) => child.stderr.write(text),
  }
}

function setup(input: Partial<ConstructorParameters<typeof GrokSession>[0]> = {}) {
  const runs: ReturnType<typeof fakeProcess>[] = []
  const argLists: string[][] = []
  const spawnFn: SpawnFn = (_file, args) => {
    argLists.push(args)
    const p = fakeProcess()
    runs.push(p)
    return p.child as never
  }
  const session = new GrokSession(
    { sessionId: 's1', cwd: '/work', ...input },
    {
      executablePath: 'grok',
      log,
      spawnFn,
      stopFn: (child) => child.kill('SIGINT'),
    },
  )
  return { session, runs, argLists }
}

const collect = (session: GrokSession) => {
  const events: SessionEvent[] = []
  void (async () => {
    for await (const e of session.events) events.push(e)
  })()
  return events
}

const tick = () => new Promise((r) => setTimeout(r, 150))
/** The nth process, waiting for it: the prompt file is written (real disk) before it is spawned. */
async function run(runs: ReturnType<typeof fakeProcess>[], n: number) {
  for (let i = 0; i < 500 && !runs[n]; i++) await new Promise((r) => setTimeout(r, 10))
  return runs[n]!
}
const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

const END = (extra: object = {}) => ({
  type: 'end',
  stopReason: 'end_turn',
  sessionId: 'g-1',
  usage: { input_tokens: 10, output_tokens: 2 },
  ...extra,
})

describe('GrokSession', () => {
  it('announces its modes, runs a turn and reports the session id', async () => {
    const { session, runs, argLists } = setup()
    const events = collect(session)
    const turn = session.prompt({ text: 'hi' })
    await tick()
    ;(await run(runs, 0)).say({ type: 'text', data: 'Hello' })
    ;(await run(runs, 0)).say(END())
    ;(await run(runs, 0)).finish(0)
    await turn
    await tick()
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('session.modes')
    expect(types).toContain('message.delta')
    expect(events.findLast((e) => e.type === 'session.provider-session')).toMatchObject({
      providerSessionId: 'g-1',
    })
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'done' })
    expect(argLists[0]).toEqual(
      expect.arrayContaining([
        '--output-format',
        'streaming-json',
        '--permission-mode',
        'acceptEdits',
        '--session-id',
      ]),
    )
    await session.close()
  })

  it('resumes the same Grok session on the next message, with the changed model and mode', async () => {
    const { session, runs, argLists } = setup()
    const first = session.prompt({ text: 'one' })
    await tick()
    ;(await run(runs, 0)).say({ type: 'text', data: 'a' })
    ;(await run(runs, 0)).say(END())
    ;(await run(runs, 0)).finish(0)
    await first

    await session.setPermissionMode('full-access')
    await session.setModel('grok-4.7', 'high')
    const second = session.prompt({ text: 'two' })
    await tick()
    ;(await run(runs, 1)).say(END())
    ;(await run(runs, 1)).finish(0)
    await second

    expect(arg(argLists[1]!, '--resume')).toBe('g-1')
    expect(argLists[1]).not.toContain('--session-id')
    expect(arg(argLists[1]!, '--permission-mode')).toBe('bypassPermissions')
    expect(arg(argLists[1]!, '--model')).toBe('grok-4.7')
    expect(arg(argLists[1]!, '--reasoning-effort')).toBe('high')
    await session.close()
  })

  it('resumes the id it was given', async () => {
    const { session, runs, argLists } = setup({ resumeId: 'old-id' })
    const turn = session.prompt({ text: 'again' })
    await tick()
    ;(await run(runs, 0)).say(END({ sessionId: 'old-id' }))
    ;(await run(runs, 0)).finish(0)
    await turn
    expect(arg(argLists[0]!, '--resume')).toBe('old-id')
    await session.close()
  })

  it('reads a line split across chunks and ignores noise', async () => {
    const { session, runs } = setup()
    const events = collect(session)
    const turn = session.prompt({ text: 'x' })
    await tick()
    ;(await run(runs, 0)).raw('not json at all\n{"type":"text","da')
    ;(await run(runs, 0)).raw('ta":"split"}\n')
    ;(await run(runs, 0)).say(END())
    ;(await run(runs, 0)).finish(0)
    await turn
    await tick()
    expect(events.filter((e) => e.type === 'message.delta')).toMatchObject([{ text: 'split' }])
    await session.close()
  })

  it('reports a failed run with a sign-in hint', async () => {
    const { session, runs } = setup()
    const events = collect(session)
    const turn = session.prompt({ text: 'x' })
    await tick()
    ;(await run(runs, 0)).stderr('Error: not logged in, please run grok login\n')
    ;(await run(runs, 0)).finish(1)
    await turn
    await tick()
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: expect.stringContaining('grok login'),
    })
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'error' })
    await session.close()
  })

  it('reports an error line and a stop reason other than a normal end', async () => {
    const { session, runs } = setup()
    const events = collect(session)
    const a = session.prompt({ text: 'x' })
    await tick()
    ;(await run(runs, 0)).say({ type: 'error', message: 'model overloaded' })
    ;(await run(runs, 0)).finish(1)
    await a
    const b = session.prompt({ text: 'y' })
    await tick()
    ;(await run(runs, 1)).say(END({ stopReason: 'max_tokens' }))
    ;(await run(runs, 1)).finish(0)
    await b
    await tick()
    expect(events.filter((e) => e.type === 'error')).toMatchObject([
      { message: 'model overloaded' },
      { message: expect.stringContaining('output limit') },
    ])
    await session.close()
  })

  it('does not resume a session that produced nothing', async () => {
    const { session, runs, argLists } = setup()
    const a = session.prompt({ text: 'x' })
    await tick()
    ;(await run(runs, 0)).finish(1)
    await a
    const b = session.prompt({ text: 'y' })
    await tick()
    ;(await run(runs, 1)).say(END())
    ;(await run(runs, 1)).finish(0)
    await b
    expect(argLists[1]).toContain('--session-id')
    expect(argLists[1]).not.toContain('--resume')
    await session.close()
  })

  it('interrupts a running turn and reports it cancelled', async () => {
    const { session, runs } = setup()
    const events = collect(session)
    const turn = session.prompt({ text: 'long' })
    await tick()
    ;(await run(runs, 0)).say({ type: 'tool_call', toolCallId: 't', title: 'x', kind: 'other' })
    await tick()
    await session.interrupt()
    await turn
    await tick()
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: false })
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'cancelled' })
    await session.close()
  })

  it('refuses a second message while one is running', async () => {
    const { session, runs } = setup()
    const turn = session.prompt({ text: 'a' })
    await tick()
    await expect(session.prompt({ text: 'b' })).rejects.toThrow(/still working/)
    ;(await run(runs, 0)).say(END())
    ;(await run(runs, 0)).finish(0)
    await turn
    await session.close()
  })

  it('locks a text-only run down and never resumes', async () => {
    const { session, runs, argLists } = setup({ textOnly: true, resumeId: 'ignored' })
    const turn = session.prompt({ text: 'write a message' })
    await tick()
    ;(await run(runs, 0)).say({ type: 'text', data: 'ok' })
    ;(await run(runs, 0)).say(END())
    ;(await run(runs, 0)).finish(0)
    await turn
    const args = argLists[0]!
    expect(args).toEqual(
      expect.arrayContaining(['--max-turns', '1', '--deny', 'Bash', '--no-subagents']),
    )
    expect(args).not.toContain('--resume')
    await session.close()
  })

  it('names the session once, with the title Grok gave it', async () => {
    const titles: string[] = []
    const runs: ReturnType<typeof fakeProcess>[] = []
    const session = new GrokSession(
      { sessionId: 's1', cwd: '/work' },
      {
        executablePath: 'grok',
        log,
        spawnFn: () => {
          const p = fakeProcess()
          runs.push(p)
          return p.child as never
        },
        titleFn: async (id) => {
          titles.push(id)
          return 'Fix the build'
        },
      },
    )
    const events = collect(session)
    for (const text of ['one', 'two']) {
      const turn = session.prompt({ text })
      await tick()
      runs.at(-1)!.say(END())
      runs.at(-1)!.finish(0)
      await turn
      await tick()
    }
    expect(events.filter((e) => e.type === 'session.renamed')).toMatchObject([
      { title: 'Fix the build' },
    ])
    expect(titles).toEqual(['g-1'])
    await session.close()
  })

  it('sends pictures as content blocks in the prompt file, and wraps text that looks like JSON', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-img-'))
    try {
      const png = path.join(dir, 'shot.png')
      writeFileSync(png, Buffer.from([1, 2, 3]))
      writeFileSync(path.join(dir, 'notes.txt'), 'x')
      const sent: string[] = []
      const runs: ReturnType<typeof fakeProcess>[] = []
      const session = new GrokSession(
        { sessionId: 's1', cwd: '/work' },
        {
          executablePath: 'grok',
          log,
          spawnFn: (_f, args) => {
            sent.push(readFileSync(arg(args, '--prompt-file')!, 'utf8'))
            const p = fakeProcess()
            runs.push(p)
            return p.child as never
          },
        },
      )
      const a = session.prompt({ text: 'look', attachments: [png, path.join(dir, 'notes.txt')] })
      await tick()
      ;(await run(runs, 0)).say(END())
      ;(await run(runs, 0)).finish(0)
      await a
      const b = session.prompt({ text: '[1, 2, 3]' })
      await tick()
      ;(await run(runs, 1)).say(END())
      ;(await run(runs, 1)).finish(0)
      await b
      const c = session.prompt({ text: 'plain words' })
      await tick()
      ;(await run(runs, 2)).say(END())
      ;(await run(runs, 2)).finish(0)
      await c

      expect(JSON.parse(sent[0]!)).toEqual([
        { type: 'text', text: 'look' },
        { type: 'image', mimeType: 'image/png', data: 'AQID' },
      ])
      expect(JSON.parse(sent[1]!)).toEqual([{ type: 'text', text: '[1, 2, 3]' }])
      expect(sent[2]).toBe('plain words')
      await session.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unknown permission mode', async () => {
    const { session } = setup()
    await expect(session.setPermissionMode('nope')).rejects.toThrow(/Unknown permission mode/)
    await session.close()
  })
})
