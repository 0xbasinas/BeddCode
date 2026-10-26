import { applyEvent, emptyReplica } from '@beddcode/client-runtime/replica'
import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { describe, expect, it } from 'vitest'
import { EventStore } from './eventStore.ts'
import { ReplayCompactor } from './compact.ts'

const replay = (events: StoredEvent[], seed = emptyReplica()) => events.reduce(applyEvent, seed)

/** Two sessions taking turns, with streamed text, tools, and state events repeating. */
function log(store: EventStore, turns = 6) {
  let at = 1000
  const add = (event: Record<string, unknown>) =>
    store.append({ at: at++, ...event } as SessionEvent)
  for (const sessionId of ['a', 'b'])
    add({ type: 'session.created', sessionId, title: sessionId, cwd: '/p', instanceId: 'claude' })
  for (let t = 0; t < turns; t++) {
    for (const sessionId of ['a', 'b']) {
      const turnId = `${sessionId}${t}`
      add({ type: 'turn.started', sessionId, turnId })
      add({ type: 'message.delta', sessionId, turnId, role: 'user', text: `hi ${t}` })
      add({ type: 'session.commands', sessionId, commands: [{ name: `c${t}`, description: '' }] })
      for (let i = 0; i < 5; i++) {
        add({ type: 'message.delta', sessionId, turnId, role: 'assistant', text: `w${i} ` })
        if (i === 2) add({ type: 'session.context', sessionId, used: t * 10 + i, size: 1000 })
      }
      add({ type: 'tool.started', sessionId, turnId, toolId: `t${t}`, kind: 'read', title: 'Read' })
      add({ type: 'tool.completed', sessionId, turnId, toolId: `t${t}`, ok: true, output: 'x' })
      add({ type: 'message.delta', sessionId, turnId, role: 'assistant', text: 'done' })
      add({ type: 'turn.completed', sessionId, turnId, reason: 'done' })
    }
  }
}

describe('ReplayCompactor', () => {
  it('builds the same sessions from far fewer events', () => {
    const store = new EventStore(':memory:')
    log(store)
    const all = store.readAfter(0, 100_000)
    const compact = new ReplayCompactor(store.latestStateSeqs(0)).compact(all)
    expect(compact.length).toBeLessThan(all.length * 0.65)
    const full = replay(all)
    const small = replay(compact)
    expect(small.sessions).toEqual(full.sessions)
    expect(small.order).toEqual(full.order)
  })

  it('resumes from a copy that is already part-way through', () => {
    const store = new EventStore(':memory:')
    log(store, 3)
    const middle = store.readAfter(0, 100_000).at(-5)!.seq
    const held = replay(store.readAfter(0, 100_000).filter((s) => s.seq <= middle))
    log(store, 3)
    const rest = store.readAfter(middle, 100_000)
    const compact = new ReplayCompactor(store.latestStateSeqs(middle)).compact(rest)
    const full = replay(store.readAfter(0, 100_000))
    expect(replay(compact, held).sessions).toEqual(full.sessions)
  })

  it('still builds the same sessions when a batch edge splits a streamed reply', () => {
    const store = new EventStore(':memory:')
    log(store)
    const all = store.readAfter(0, 100_000)
    const keep = store.latestStateSeqs(0)
    const compactor = new ReplayCompactor(keep)
    const pieces: StoredEvent[] = []
    for (let i = 0; i < all.length; i += 7) pieces.push(...compactor.compact(all.slice(i, i + 7)))
    expect(replay(pieces).sessions).toEqual(replay(all).sessions)
    const seqs = pieces.map((p) => p.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('gives each log its own id, kept across opens', () => {
    expect(new EventStore(':memory:').logId).not.toBe(new EventStore(':memory:').logId)
  })
})
