import { expect, it } from 'vitest'
import { lastUsedModel, projectSegmentEvent } from './segments.ts'
import type { SessionEvent, SessionSegment } from './events.ts'

it('finds a provider last-used model and effort across switches', () => {
  const events = [
    { type: 'session.created', instanceId: 'a', title: 't', cwd: '/', model: 'a1' },
    { type: 'session.model', model: 'a2', effort: 'high' },
    { type: 'session.switched', instanceId: 'b', handoff: '' },
    { type: 'session.model', model: 'b1', effort: 'low' },
    { type: 'session.switched', instanceId: 'a', model: 'a2', effort: 'high', handoff: '' },
  ].map((e, i) => ({ sessionId: 's', at: i + 1, ...e }) as SessionEvent)
  const segments = events.reduce(projectSegmentEvent, [] as SessionSegment[])
  expect(lastUsedModel(segments.slice(0, 3), 'b')).toEqual({ model: 'b1', effort: 'low' })
  expect(lastUsedModel(segments.slice(0, 2), 'a')).toEqual({ model: 'a2', effort: 'high' })
  expect(lastUsedModel(segments.slice(0, 1), 'b')).toBeUndefined()
})
