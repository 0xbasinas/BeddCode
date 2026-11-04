import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionSegment, type SessionEvent } from '@beddcode/contracts'
import { applyEvent, emptyReplica } from '@beddcode/client-runtime/replica'
import { EventStore } from './eventStore.ts'

describe('durable session segments', () => {
  it('replays switches and legacy sessions after reopening the event log', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bc-segments-'))
    const file = path.join(dir, 'events.db')
    let store = new EventStore(file)
    const events: SessionEvent[] = [
      {
        type: 'session.created',
        sessionId: 's',
        at: 1,
        title: 'Work',
        cwd: '/p',
        instanceId: 'claude',
        model: 'old',
      },
      { type: 'session.provider-session', sessionId: 's', at: 2, providerSessionId: 'c1' },
      { type: 'session.model', sessionId: 's', at: 3, model: 'new' },
      {
        type: 'session.created',
        sessionId: 'legacy',
        at: 4,
        title: 'Legacy',
        cwd: '/p',
        instanceId: 'codex',
      },
      {
        type: 'session.provider-session',
        sessionId: 'legacy',
        at: 5,
        providerSessionId: 'legacy-id',
      },
      {
        type: 'session.switched',
        sessionId: 's',
        at: 6,
        instanceId: 'codex',
        model: 'o3',
        handoff: 'first context',
      },
      { type: 'session.provider-session', sessionId: 's', at: 7, providerSessionId: 'c2' },
      {
        type: 'session.switched',
        sessionId: 's',
        at: 8,
        instanceId: 'claude',
        handoff: 'return context',
      },
      { type: 'session.provider-session', sessionId: 's', at: 9, providerSessionId: 'c1' },
    ]
    try {
      store.appendMany(events)
      const expected = [
        { provider: 'claude', model: 'new', nativeSessionId: 'c1', startedAt: 1, endedAt: 6 },
        {
          provider: 'codex',
          model: 'o3',
          nativeSessionId: 'c2',
          startedAt: 6,
          endedAt: 8,
          handoffContext: 'first context',
        },
        {
          provider: 'claude',
          model: undefined,
          nativeSessionId: 'c1',
          startedAt: 8,
          handoffContext: 'return context',
        },
      ]
      expect(store.sessionSegments('s')).toEqual(expected)
      store.close()
      store = new EventStore(file)
      expect(store.sessionSegments('s')).toEqual(expected)
      expect(store.sessionSegments('legacy')).toEqual([
        { provider: 'codex', model: undefined, nativeSessionId: 'legacy-id', startedAt: 4 },
      ])
      expect(store.sessionSegments('missing')).toEqual([])
      expect(store.sessionMeta(['s']).get('s')).toMatchObject({
        instanceId: 'claude',
        model: undefined,
      })
      const replica = store.readAfter(0).reduce(applyEvent, emptyReplica())
      expect(replica.sessions.s?.segments).toEqual(expected)
      expect(replica.sessions.legacy?.segments).toEqual(store.sessionSegments('legacy'))
      expect(expected.every((segment) => SessionSegment.safeParse(segment).success)).toBe(true)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
