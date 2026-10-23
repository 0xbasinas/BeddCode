import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EventStore } from './eventStore.ts'
import { migrations } from './migrations.ts'
import { dropRepeatedSnapshots } from './snapshots.ts'

const turnStarted = (sessionId: string): SessionEvent => ({
  type: 'turn.started',
  sessionId,
  at: 1,
})

describe('EventStore', () => {
  it('assigns increasing sequence numbers and replays after a cursor', () => {
    const store = new EventStore(':memory:')
    const a = store.append(turnStarted('s1'))
    const b = store.append(turnStarted('s2'))
    const c = store.append(turnStarted('s1'))
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect(store.readAfter(1).map((e) => e.seq)).toEqual([2, 3])
    expect(store.readAfter(3)).toEqual([])
    expect(store.lastSeq()).toBe(3)
  })

  it('notifies listeners after the event is committed', () => {
    const store = new EventStore(':memory:')
    const seen: number[] = []
    const off = store.subscribe((s) => {
      expect(store.lastSeq()).toBe(s.seq)
      seen.push(s.seq)
    })
    store.append(turnStarted('s1'))
    off()
    store.append(turnStarted('s1'))
    expect(seen).toEqual([1])
  })

  it('rejects invalid events', () => {
    const store = new EventStore(':memory:')
    expect(() => store.append({ type: 'nope' } as unknown as SessionEvent)).toThrow()
  })
})

describe('repeated state snapshots', () => {
  const commands = (sessionId: string, names: string[], at = 1): SessionEvent => ({
    type: 'session.commands',
    sessionId,
    at,
    turnId: `turn-${at}`,
    commands: names.map((name) => ({ name, kind: 'command' as const })),
  })

  it('stores and sends a commands list only when it changes, per session', () => {
    const store = new EventStore(':memory:')
    const seen: string[] = []
    store.subscribe((s) => seen.push(`${s.seq}:${s.event.type}`))
    const first = store.append(commands('s1', ['compact']))
    const again = store.append(commands('s1', ['compact'], 5))
    store.append(commands('s2', ['compact']))
    store.append(commands('s1', ['compact', 'review'], 6))
    store.append(commands('s1', ['compact'], 7))
    expect(again.seq).toBe(first.seq)
    expect(seen).toEqual([
      '1:session.commands',
      '2:session.commands',
      '3:session.commands',
      '4:session.commands',
    ])
    expect(store.readSession('s1')).toHaveLength(3)
  })

  it('remembers the last stored list across restarts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bc-store-'))
    const file = path.join(dir, 'events.db')
    const a = new EventStore(file)
    a.append(commands('s1', ['compact']))
    a.close()
    const b = new EventStore(file)
    b.append(commands('s1', ['compact'], 9))
    b.append({ type: 'session.modes', sessionId: 's1', at: 2, modes: [], currentModeId: 'ask' })
    b.append({ type: 'session.modes', sessionId: 's1', at: 3, modes: [], currentModeId: 'ask' })
    b.append({ type: 'session.modes', sessionId: 's1', at: 4, modes: [], currentModeId: 'auto' })
    expect(b.readSession('s1').map((e) => e.event.type)).toEqual([
      'session.commands',
      'session.modes',
      'session.modes',
    ])
    b.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('drops repeats already in an older log once, keeping what replay depends on', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(migrations[0] as string)
    const insert = db.prepare(
      'INSERT INTO events (session_id, type, at, payload) VALUES (?, ?, ?, ?)',
    )
    const add = (e: SessionEvent) => insert.run(e.sessionId, e.type, e.at, JSON.stringify(e))
    add(commands('s1', ['a']))
    add(turnStarted('s1'))
    add(commands('s1', ['a'], 2))
    add(commands('s2', ['a'], 2))
    add(commands('s1', ['b'], 3))
    add(commands('s1', ['a'], 4))
    add(commands('s1', ['a'], 5))
    expect(dropRepeatedSnapshots(db)).toBe(2)
    const left = db.prepare('SELECT seq FROM events ORDER BY seq').all() as { seq: number }[]
    expect(left.map((r) => r.seq)).toEqual([1, 2, 4, 5, 6])
    expect(dropRepeatedSnapshots(db)).toBe(0)
  })
})
