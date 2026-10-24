import { describe, expect, it } from 'vitest'
import type { ReplicaState, SessionView, TranscriptItem } from '@beddcode/client-runtime/replica'
import type { ProviderInstance } from '@beddcode/contracts'
import { chooseAgent, chooseMode, chooseModel } from './agents.ts'
import { parseArgs } from './args.ts'
import type { Conn } from './connection.ts'
import { answerWaiting, follow, Printer } from './follow.ts'
import { addHost, parseAddress, pickTargets, type HostTarget } from './hosts.ts'
import type { Io } from './io.ts'
import {
  age,
  findSession,
  formatSessions,
  lastReply,
  newMemo,
  phaseOf,
  renderNew,
  undoableChanges,
  waitingOn,
} from './render.ts'

const view = (over: Partial<SessionView> = {}): SessionView =>
  ({
    id: 'aaaaaaaa-1111',
    title: 'Fix login',
    cwd: '/p',
    instanceId: 'claude',
    projectPath: '/p',
    createdAt: 0,
    updatedAt: 1000,
    status: 'idle',
    items: [],
    added: 0,
    removed: 0,
    turns: 0,
    completedTurns: 0,
    queue: [],
    commands: [],
    config: [],
    ...over,
  }) as SessionView

describe('parseArgs', () => {
  it('reads flags, values, aliases and what is left over', () => {
    const r = parseArgs(['fix it', '--agent', 'codex', '-n', '5', '--wait', '--model=opus'], {
      bool: ['wait'],
      string: ['agent', 'lines', 'model'],
      alias: { n: 'lines' },
    })
    expect(r.rest).toEqual(['fix it'])
    expect(r.flags).toEqual({ agent: 'codex', lines: '5', wait: true, model: 'opus' })
  })

  it('collects repeated flags and stops at --', () => {
    const r = parseArgs(['--tag', 'a', '--tag', 'b', '--', '--not-a-flag'], { repeat: ['tag'] })
    expect(r.flags.tag).toEqual(['a', 'b'])
    expect(r.rest).toEqual(['--not-a-flag'])
  })

  it('rejects an unknown flag, a missing value and a value on a switch', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown option: --nope')
    expect(() => parseArgs(['--agent'], { string: ['agent'] })).toThrow('--agent needs a value')
    expect(() => parseArgs(['--wait=1'], { bool: ['wait'] })).toThrow('takes no value')
  })
})

describe('listing', () => {
  it('names what a session is doing', () => {
    expect(phaseOf(view({ status: 'needs-you' }))).toBe('needs you')
    expect(phaseOf(view({ status: 'running' }))).toBe('running')
    expect(phaseOf(view({ done: true }))).toBe('done')
    expect(phaseOf(view())).toBe('idle')
  })

  it('formats ages', () => {
    expect(age(0, 30_000)).toBe('30s')
    expect(age(0, 5 * 60_000)).toBe('5m')
    expect(age(0, 3 * 3_600_000)).toBe('3h')
    expect(age(0, 2 * 86_400_000)).toBe('2d')
  })

  it('prints newest first, with a host column only for several hosts', () => {
    const older = view({ id: 'bbbbbbbb-2222', title: 'Older', updatedAt: 500 })
    const one = formatSessions(
      [
        { host: 'local', view: older },
        { host: 'local', view: view() },
      ],
      2000,
    )
    expect(one.split('\n')[1]).toContain('aaaaaaaa')
    expect(one).not.toContain('HOST')
    const two = formatSessions(
      [
        { host: 'local', view: view() },
        { host: 'build', view: older },
      ],
      2000,
    )
    expect(two).toContain('HOST')
    expect(formatSessions([])).toBe('No sessions.')
  })
})

describe('findSession', () => {
  const rows = [
    { host: 'local', view: view() },
    { host: 'local', view: view({ id: 'aaaabbbb-9', title: 'Add dark mode', updatedAt: 9000 }) },
    { host: 'local', view: view({ id: 'cccccccc-3', title: 'Fix signup', updatedAt: 500 }) },
  ]

  it('finds by id, id prefix, title part and "last"', () => {
    expect(findSession(rows, 'aaaaaaaa-1111').view.title).toBe('Fix login')
    expect(findSession(rows, 'cccc').view.title).toBe('Fix signup')
    expect(findSession(rows, 'dark').view.title).toBe('Add dark mode')
    expect(findSession(rows, 'last').view.id).toBe('aaaabbbb-9')
  })

  it('says what is ambiguous or missing', () => {
    expect(() => findSession(rows, 'aaaa')).toThrow('matches 2 sessions')
    expect(() => findSession(rows, 'fix')).toThrow('matches 2 sessions')
    expect(() => findSession(rows, 'nothing')).toThrow('No session matches')
  })
})

const message = (id: string, role: 'user' | 'assistant', text: string): TranscriptItem => ({
  kind: 'message',
  id,
  role,
  text,
})
const tool = (id: string, status: 'running' | 'ok' | 'failed'): TranscriptItem => ({
  kind: 'tool',
  id,
  title: 'Run tests',
  toolKind: 'command',
  status,
})

describe('renderNew', () => {
  it('prints only what is new, streaming the answer', () => {
    const memo = newMemo()
    let v = view({ items: [message('1', 'user', 'hi'), message('2', 'assistant', 'Hel')] })
    expect(renderNew(v, memo)).toEqual({ text: ['Hel'], activity: [] })
    v = view({ items: [message('1', 'user', 'hi'), message('2', 'assistant', 'Hello there')] })
    expect(renderNew(v, memo).text).toEqual(['lo there'])
    expect(renderNew(v, memo)).toEqual({ text: [], activity: [] })
  })

  it('reports a tool once when it starts, and again only if it fails', () => {
    const memo = newMemo()
    expect(renderNew(view({ items: [tool('t', 'running')] }), memo).activity).toEqual([
      '▸ Run tests',
    ])
    expect(renderNew(view({ items: [tool('t', 'ok')] }), memo).activity).toEqual([])
    expect(renderNew(view({ items: [tool('u', 'running')] }), memo).activity).toEqual([
      '▸ Run tests',
    ])
    expect(renderNew(view({ items: [tool('u', 'failed')] }), memo).activity).toEqual(['  ✗ failed'])
  })

  it('takes the reply of the latest turn only', () => {
    const v = view({
      items: [
        message('1', 'user', 'a'),
        message('2', 'assistant', 'old'),
        message('3', 'user', 'b'),
        message('4', 'assistant', 'one'),
        tool('t', 'ok'),
        message('5', 'assistant', 'two'),
      ],
    })
    expect(lastReply(v)).toBe('one\n\ntwo')
  })
})

describe('waiting and undo', () => {
  const approval: TranscriptItem = {
    kind: 'approval',
    id: 'a',
    requestId: 'r1',
    title: 'Run rm -rf build',
    options: [
      { id: 'yes', label: 'Allow once', kind: 'allow' },
      { id: 'no', label: 'Deny', kind: 'deny' },
    ],
  }

  it('finds an open approval and ignores a resolved one', () => {
    expect(waitingOn(view({ items: [approval] }))?.kind).toBe('approval')
    expect(waitingOn(view({ items: [{ ...approval, resolvedOptionId: 'yes' }] }))).toBeNull()
  })

  it('offers the latest changes unless they were undone', () => {
    const changes: TranscriptItem = {
      kind: 'changes',
      id: 'c',
      before: 'b',
      after: 'a',
      files: [],
    }
    expect(undoableChanges(view({ items: [changes] }))?.after).toBe('a')
    expect(undoableChanges(view({ items: [{ ...changes, reverted: true }] }))).toBeNull()
    expect(undoableChanges(view())).toBeNull()
  })
})

const provider = (over: Partial<ProviderInstance> & { id: string }) =>
  ({
    kind: over.id,
    label: over.id,
    status: 'ready',
    capabilities: { permissionModes: [], ...over.capabilities },
    ...over,
  }) as ProviderInstance

describe('choosing agent, mode and model', () => {
  const claude = provider({
    id: 'claude',
    capabilities: {
      permissionModes: [{ id: 'default', label: 'Ask before edits' }],
      models: [{ id: 'opus', label: 'Opus' }],
    } as never,
  })
  const codex = provider({ id: 'codex' })

  it('prefers Claude, then Codex, then anything ready', () => {
    expect(chooseAgent([codex, claude]).id).toBe('claude')
    expect(chooseAgent([provider({ id: 'grok' }), codex]).id).toBe('codex')
    expect(chooseAgent([provider({ id: 'grok' })]).id).toBe('grok')
  })

  it('takes a named agent, and says when it cannot', () => {
    expect(chooseAgent([claude, codex], 'Codex').id).toBe('codex')
    expect(() => chooseAgent([claude], 'nope')).toThrow('Available: claude')
    expect(() => chooseAgent([provider({ id: 'x', status: 'needs-sign-in' })])).toThrow(
      'No agent is ready',
    )
    expect(() => chooseAgent([provider({ id: 'x', status: 'needs-sign-in' })], 'x')).toThrow(
      'not ready',
    )
  })

  it('checks a mode and a model against what the agent offers', () => {
    expect(chooseMode(claude, 'ask before edits')).toBe('default')
    expect(() => chooseMode(claude, 'full')).toThrow('Modes: default')
    expect(chooseModel(claude, 'Opus')).toBe('opus')
    expect(() => chooseModel(claude, 'x')).toThrow('Models: opus')
    expect(chooseMode(codex, 'anything')).toBe('anything')
  })
})

describe('hosts', () => {
  it('reads addresses with and without a scheme or port', () => {
    expect(parseAddress('build')).toEqual({
      http: 'http://build:3773',
      ws: 'ws://build:3773/ws',
    })
    expect(parseAddress('build:4000').ws).toBe('ws://build:4000/ws')
    expect(parseAddress('https://box.ts.net').ws).toBe('wss://box.ts.net:3773/ws')
  })

  it('picks a host by name and replaces one paired again', () => {
    const local: HostTarget = { name: 'local', urls: ['ws://x'], local: true }
    const a: HostTarget = { name: 'a', urls: ['ws://a'], hostId: '1' }
    expect(pickTargets([local, a], 'A')).toEqual([a])
    expect(() => pickTargets([local, a], 'zz')).toThrow('No host named')
    expect(addHost([a], { ...a, token: 't' })).toEqual([{ ...a, token: 't' }])
    expect(() => addHost([], { name: 'local', urls: [] })).toThrow('own host')
  })
})

/** A connection whose sessions the test changes by hand. */
function fakeConn(initial: SessionView) {
  let state: ReplicaState = { lastSeq: 0, order: [initial.id], sessions: { [initial.id]: initial } }
  const listeners = new Set<(s: ReplicaState) => void>()
  const requests: [string, unknown][] = []
  const conn = {
    target: { name: 'local', urls: [] },
    host: {},
    state: () => state,
    request: async (method: string, params: unknown) => {
      requests.push([method, params])
      return {}
    },
    onChange: (l: (s: ReplicaState) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    close() {},
  } as unknown as Conn
  const update = (next: SessionView) => {
    state = { ...state, sessions: { [next.id]: next } }
    listeners.forEach((l) => l(state))
  }
  return { conn, update, requests }
}

function fakeIo(answers: string[] = []) {
  const out: string[] = []
  const err: string[] = []
  const io: Io = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    interactive: answers.length > 0,
    ask: async () => answers.shift() ?? '',
  }
  return { io, out, err }
}

describe('follow', () => {
  it('streams the answer and finishes when the turn ends', async () => {
    const { conn, update } = fakeConn(view({ status: 'running', completedTurns: 0 }))
    const { io, out, err } = fakeIo()
    const done = follow(conn, 'aaaaaaaa-1111', {
      io,
      printer: new Printer(io),
      afterTurns: 0,
      interactive: false,
    })
    update(
      view({ status: 'running', items: [tool('t', 'running'), message('m', 'assistant', 'Do')] }),
    )
    update(
      view({
        status: 'idle',
        completedTurns: 1,
        lastTurnReason: 'done',
        items: [tool('t', 'ok'), message('m', 'assistant', 'Done.')],
      }),
    )
    expect(await done).toBe('done')
    expect(out.join('')).toBe('Done.\n')
    expect(err.join('')).toBe('▸ Run tests\n')
  })

  it('reports a failed turn, and a request it cannot ask about', async () => {
    const failed = fakeConn(view({ status: 'running' }))
    const { io } = fakeIo()
    const a = follow(failed.conn, 'aaaaaaaa-1111', {
      io,
      printer: new Printer(io),
      afterTurns: 0,
      interactive: false,
    })
    failed.update(view({ status: 'failed' }))
    expect(await a).toBe('error')

    const waiting = fakeConn(view({ status: 'running' }))
    const b = follow(waiting.conn, 'aaaaaaaa-1111', {
      io,
      printer: new Printer(io),
      afterTurns: 0,
      interactive: false,
    })
    waiting.update(
      view({
        status: 'needs-you',
        items: [
          {
            kind: 'approval',
            id: 'a',
            requestId: 'r',
            title: 'Run it',
            options: [{ id: 'yes', label: 'Allow', kind: 'allow' }],
          },
        ],
      }),
    )
    expect(await b).toBe('needs-you')
  })
})

describe('answerWaiting', () => {
  it('sends the option a person picks, asking again for a bad answer', async () => {
    const { conn, requests } = fakeConn(view())
    const { io, err } = fakeIo(['9', 'deny'])
    await answerWaiting(
      conn,
      's1',
      {
        kind: 'approval',
        item: {
          kind: 'approval',
          id: 'a',
          requestId: 'r1',
          title: 'Run it',
          options: [
            { id: 'yes', label: 'Allow once', kind: 'allow' },
            { id: 'no', label: 'Deny', kind: 'deny' },
          ],
        },
      },
      io,
    )
    expect(err.join('')).toContain('Type a number')
    expect(requests).toEqual([
      ['sessions.approve', { sessionId: 's1', requestId: 'r1', optionId: 'no' }],
    ])
  })

  it('answers questions by option number or free text', async () => {
    const { conn, requests } = fakeConn(view())
    const { io } = fakeIo(['2', 'blue'])
    await answerWaiting(
      conn,
      's1',
      {
        kind: 'question',
        item: {
          kind: 'question',
          id: 'q',
          requestId: 'r2',
          questions: [
            { id: 'a', question: 'Pick', options: [{ label: 'X' }, { label: 'Y' }] },
            { id: 'b', question: 'Colour?' },
          ],
        },
      },
      io,
    )
    expect(requests).toEqual([
      ['sessions.answer', { sessionId: 's1', requestId: 'r2', answers: { a: ['Y'], b: ['blue'] } }],
    ])
  })
})
