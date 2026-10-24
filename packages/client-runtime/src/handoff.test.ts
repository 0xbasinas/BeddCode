import { describe, expect, it } from 'vitest'
import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { handoffPrompt } from './handoff.ts'
import { applyEvent, emptyReplica, type ReplicaState, type SessionView } from './replica.ts'
import { searchSessions, snippetAround } from './sessionSearch.ts'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'at'> : never

function fold(events: Draft[]): ReplicaState {
  let state = emptyReplica()
  events.forEach((e, i) => {
    state = applyEvent(state, {
      seq: i + 1,
      event: { at: i + 1, ...e } as SessionEvent,
    } satisfies StoredEvent)
  })
  return state
}

const session = (id: string, title: string) => ({
  type: 'session.created' as const,
  sessionId: id,
  title,
  cwd: `/work/${id}`,
  instanceId: 'claude',
  branch: 'topic',
})

describe('turn changes in the replica', () => {
  it('adds a changes card per turn, marks undone ones, and pins without reordering', () => {
    const s = fold([
      session('s1', 'Fix it'),
      { type: 'message.delta', sessionId: 's1', role: 'user', text: 'fix' },
      { type: 'turn.completed', sessionId: 's1', reason: 'done' },
      {
        type: 'turn.changes',
        sessionId: 's1',
        before: 'a'.repeat(40),
        after: 'b'.repeat(40),
        files: [{ path: 'x.ts', status: 'M', added: 2, removed: 1 }],
      },
      { type: 'session.pinned', sessionId: 's1', pinned: true },
    ])
    const view = s.sessions.s1!
    expect(view.pinned).toBe(true)
    expect(view.updatedAt).toBe(3)
    expect(view.items.at(-1)).toMatchObject({ kind: 'changes', after: 'b'.repeat(40) })
    expect([view.added, view.removed]).toEqual([2, 1])

    const undone = applyEvent(s, {
      seq: 99,
      event: { type: 'turn.reverted', sessionId: 's1', at: 99, after: 'b'.repeat(40) },
    })
    expect(undone.sessions.s1!.items.at(-1)).toMatchObject({ kind: 'changes', reverted: true })
    // Undone work no longer counts in the session's totals (the sidebar shows them).
    expect([undone.sessions.s1!.added, undone.sessions.s1!.removed]).toEqual([0, 0])
    const unpinned = applyEvent(undone, {
      seq: 100,
      event: { type: 'session.pinned', sessionId: 's1', at: 100, pinned: false },
    })
    expect(unpinned.sessions.s1!.pinned).toBeUndefined()
  })
})

describe('handoffPrompt', () => {
  const view = (): SessionView =>
    fold([
      session('s1', 'Rate limiter'),
      { type: 'message.delta', sessionId: 's1', role: 'user', text: 'Fix the  rate\nlimiter' },
      { type: 'message.delta', sessionId: 's1', role: 'assistant', text: 'Looking at it.' },
      {
        type: 'tool.started',
        sessionId: 's1',
        toolId: 't1',
        kind: 'command',
        title: 'pnpm test',
      },
      { type: 'diff', sessionId: 's1', path: 'src/a.ts', added: 1, removed: 1, patch: '' },
      { type: 'turn.completed', sessionId: 's1', reason: 'done' },
    ]).sessions.s1!

  it('summarizes messages, commands and changed files with the folder and branch', () => {
    const text = handoffPrompt(view(), { agentLabel: 'Claude' })
    expect(text).toContain('started with Claude in "Rate limiter"')
    expect(text).toContain('Folder: /work/s1')
    expect(text).toContain('Branch: topic')
    expect(text).toContain('- I asked: Fix the rate limiter')
    expect(text).toContain('- The agent said: Looking at it.')
    expect(text).toContain('- Ran: pnpm test')
    expect(text).toContain('Files changed so far: src/a.ts')
    expect(text.trimEnd().endsWith('Next:')).toBe(true)
  })

  it('keeps the latest context when it has to cut', () => {
    const long = fold([
      session('s1', 'Long'),
      ...Array.from({ length: 60 }, (_, i) => ({
        type: 'message.delta' as const,
        sessionId: 's1',
        role: 'user' as const,
        text: `message number ${i} ${'x'.repeat(100)}`,
      })),
    ]).sessions.s1!
    const text = handoffPrompt(long, { maxChars: 1_500 })
    expect(text.length).toBeLessThanOrEqual(1_500)
    expect(text).toContain('(earlier messages left out)')
    expect(text).toContain('message number 59')
    expect(text).not.toContain('message number 0 ')
  })
})

describe('searchSessions', () => {
  const state = fold([
    session('s1', 'Rate limiter'),
    {
      type: 'message.delta',
      sessionId: 's1',
      role: 'user',
      text: 'Why does the token bucket overflow at midnight?',
    },
    session('s2', 'Docs'),
    { type: 'message.delta', sessionId: 's2', role: 'user', text: 'Write the README' },
  ])
  const views = Object.values(state.sessions)

  it('finds sessions by title or by words in any message, with a snippet', () => {
    expect(searchSessions(views, 'rate')).toEqual([{ sessionId: 's1', field: 'title' }])
    expect(searchSessions(views, 'midnight BUCKET')).toEqual([
      {
        sessionId: 's1',
        field: 'message',
        role: 'user',
        snippet: 'Why does the token bucket overflow at midnight?',
      },
    ])
    expect(searchSessions(views, 'readme')[0]?.sessionId).toBe('s2')
    expect(searchSessions(views, 'nothing like this')).toEqual([])
    expect(searchSessions(views, '   ')).toEqual([])
  })

  it('cuts long snippets around the hit', () => {
    const text = `${'a '.repeat(100)}needle ${'b '.repeat(100)}`
    const snip = snippetAround(text, 'needle', 40)
    expect(snip).toContain('needle')
    expect(snip.startsWith('…')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
  })
})
