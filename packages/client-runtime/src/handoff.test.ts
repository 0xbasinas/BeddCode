import { describe, expect, it } from 'vitest'
import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { handoffPrompt, parseHandoffNote } from './handoff.ts'
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

describe('handoffPrompt changed files', () => {
  it('lists a file once when the agent reports it absolute and git relative', () => {
    const view = fold([
      { ...session('s1', 'Tests'), cwd: '/tmp/repo' },
      { type: 'message.delta', sessionId: 's1', role: 'user', text: 'Add a test' },
      {
        type: 'diff',
        sessionId: 's1',
        path: '/tmp/repo/sum.test.mjs',
        added: 1,
        removed: 0,
        patch: '',
      },
    ]).sessions.s1!
    const note = handoffPrompt(view, {
      files: [{ path: 'sum.test.mjs', patch: '@@ -2,3 +2,4 @@ ctx\n+x' }],
    })
    expect(note.match(/sum\.test\.mjs/g)).toHaveLength(1)
    expect(note).toContain('- sum.test.mjs (+1/-0) @@ -2,3 +2,4 @@ ctx')
    expect(note).not.toContain('/tmp/repo/sum.test.mjs')
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

  const rich = (): SessionView =>
    fold([
      session('s1', 'Rate limiter'),
      { type: 'message.delta', sessionId: 's1', role: 'user', text: 'Fix the  rate\nlimiter' },
      {
        type: 'message.delta',
        sessionId: 's1',
        role: 'assistant',
        text: 'Looking at it.\nDecided to use a token bucket.',
      },
      {
        type: 'plan.updated',
        sessionId: 's1',
        steps: [{ text: 'Add bucket', status: 'completed' }],
      },
      { type: 'tool.started', sessionId: 's1', toolId: 't1', kind: 'command', title: 'pnpm test' },
      { type: 'diff', sessionId: 's1', path: 'src/a.ts', added: 1, removed: 1, patch: '' },
      { type: 'turn.completed', sessionId: 's1', reason: 'done' },
    ]).sessions.s1!

  it('writes labelled sections with no empty gaps', () => {
    const text = handoffPrompt(rich(), {
      agentLabel: 'Claude',
      targetLabel: 'Codex',
      pendingMessage: 'Please finish',
      files: [{ path: 'src/b.ts', patch: '@@ -1,2 +1,3 @@ fn\n+x\n+y\n-z\n' }],
    })
    const titles = [...text.matchAll(/^## (.*)$/gm)].map((m) => m[1])
    expect(titles).toEqual([
      'Reason for the switch',
      'Goal',
      'Plan',
      'Decisions',
      'Changed files',
      'Recent turns',
      'Pending message',
    ])
    expect(text).toContain('switched this session from Claude to Codex')
    expect(text).toContain('Fix the rate limiter')
    expect(text).toContain('Folder: /work/s1')
    expect(text).toContain('- [completed] Add bucket')
    expect(text).toContain('- Decided to use a token bucket.')
    expect(text).toContain('- src/a.ts (+1/-1)')
    expect(text).toContain('- src/b.ts (+2/-1) @@ -1,2 +1,3 @@ fn')
    expect(text).toContain('- You asked: Fix the rate limiter')
    expect(text).toContain('- Ran: pnpm test')
    expect(text).toContain('Please finish')
    expect(text).not.toMatch(/\n\n\n/)
    expect(text).not.toMatch(/^## .*\n\n/m)
  })

  it('omits sections that have nothing in them', () => {
    const text = handoffPrompt(view())
    expect(text).not.toContain('## Plan')
    expect(text).not.toContain('## Decisions')
    expect(text).not.toContain('## Pending message')
    expect(text).toContain('## Changed files')
    expect(text).toContain('Fix the rate limiter')
    expect(text).toContain('Reason for the switch')
  })

  it('uses an explicit reason', () => {
    expect(handoffPrompt(view(), { reason: 'Automatic handoff: rate limit' })).toContain(
      'Automatic handoff: rate limit',
    )
  })

  it('retains the continuation link in the replica', () => {
    const state = fold([
      { ...session('s2', 'Continued'), handoffFrom: { sessionId: 's1', title: 'Original' } },
    ])
    expect(state.sessions.s2?.handoffFrom).toEqual({ sessionId: 's1', title: 'Original' })
  })

  const long = () =>
    fold([
      session('s1', 'Long'),
      ...Array.from({ length: 60 }, (_, i) => ({
        type: 'message.delta' as const,
        sessionId: 's1',
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        text: `message number ${i} ${'x'.repeat(100)}`,
      })),
    ]).sessions.s1!

  it('drops the oldest turns first and marks the section trimmed', () => {
    const text = handoffPrompt(long(), { maxChars: 1_500, pendingMessage: 'finish' })
    expect(text.length).toBeLessThanOrEqual(1_500)
    expect(text).toContain('## Recent turns (trimmed)')
    expect(text).toContain('message number 59')
    expect(text).toContain('Goal')
    expect(text).toContain('message number 0 ')
    expect(text.match(/message number 0 /g)).toHaveLength(1) // only the goal
    expect(text).toContain('## Pending message\nfinish')
  })

  it('trims turns, then diff detail, then decisions, but keeps reason, goal and pending', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      patch: `@@ -1,1 +1,1 @@ section ${i}\n+a\n-b`,
    }))
    const base = { files, pendingMessage: 'finish it' }
    const full = handoffPrompt(rich(), base)
    // Just under the full size: only turns shrink.
    const a = handoffPrompt(rich(), { ...base, maxChars: full.length - 20 })
    expect(a).toContain('## Recent turns (trimmed)')
    expect(a).toContain('section 0')
    expect(a).toContain('Decided to use a token bucket')
    // Tighter: hunk headers go before decisions.
    const tight = full.indexOf('## Recent turns') + 20
    const b = handoffPrompt(rich(), { ...base, maxChars: tight })
    expect(b).toContain('## Changed files (trimmed)')
    expect(b).not.toContain('section 0')
    expect(b).toContain('Decided to use a token bucket')
    // Tighter still: decisions are next.
    const c = handoffPrompt(rich(), { ...base, maxChars: full.length - 700 })
    expect(c).toContain('## Decisions (trimmed)')
    expect(c).not.toContain('Decided to use')
    // Always: the essentials.
    const d = handoffPrompt(rich(), { ...base, maxChars: 500 })
    expect(d.length).toBeLessThanOrEqual(500)
    for (const kept of ['Reason for the switch', '## Goal', 'Fix the rate limiter', 'finish it'])
      expect(d).toContain(kept)
  })

  it('bounds even a tiny budget', () => {
    expect(
      handoffPrompt(view(), { maxChars: 80, files: [{ path: 'x'.repeat(5000) }] }).length,
    ).toBeLessThanOrEqual(80)
  })

  it('formats a delta without the goal, and with only files touched since then', () => {
    const text = handoffPrompt(view(), {
      delta: true,
      agentLabel: 'Codex',
      pendingMessage: 'next',
      files: [
        { path: 'src/a.ts', patch: '@@ -1 +1 @@\n+a\n-b' },
        { path: 'old/untouched.ts', patch: '+x' },
      ],
    })
    expect(text).toContain('# Handoff update')
    expect(text).toContain('switched back to you from Codex')
    expect(text).toContain('## What happened meanwhile')
    expect(text).toContain('Looking at it.')
    expect(text).toContain('src/a.ts (+1/-1)')
    expect(text).not.toContain('untouched')
    expect(text).not.toContain('## Goal')
    expect(text).toContain('## Pending message\nnext')
  })

  it('parses a note back into its sections', () => {
    const parts = parseHandoffNote(handoffPrompt(rich(), { pendingMessage: 'go' }))
    expect(parts.map((p) => p.title)).toEqual([
      'Reason for the switch',
      'Goal',
      'Plan',
      'Decisions',
      'Changed files',
      'Recent turns',
      'Pending message',
    ])
    expect(parts.at(-1)?.body).toBe('go')
    expect(parseHandoffNote('just text')).toEqual([{ body: 'just text' }])
  })

  it('reconstructs provider segments from the event log', () => {
    const state = fold([
      session('s1', 'Work'),
      { type: 'session.provider-session', sessionId: 's1', providerSessionId: 'native-1' },
      {
        type: 'session.switched',
        sessionId: 's1',
        instanceId: 'codex',
        model: 'm',
        handoff: 'context',
      },
      { type: 'session.provider-session', sessionId: 's1', providerSessionId: 'native-2' },
    ])
    expect(state.sessions.s1?.segments).toEqual([
      {
        provider: 'claude',
        model: undefined,
        startedAt: 1,
        nativeSessionId: 'native-1',
        endedAt: 3,
      },
      {
        provider: 'codex',
        model: 'm',
        startedAt: 3,
        handoffContext: 'context',
        nativeSessionId: 'native-2',
      },
    ])
    expect(state.sessions.s1?.instanceId).toBe('codex')
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
