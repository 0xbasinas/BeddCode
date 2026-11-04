import { expect, it } from 'vitest'
import { lastUsedModel, projectSegmentEvent, projectSessionSegments } from './segments.ts'
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

it('learns a provider model reported only as a config setting', () => {
  const segments = projectSessionSegments([
    ...[
      { type: 'session.created', instanceId: 'grok', title: 't', cwd: '/' },
      {
        type: 'session.config',
        options: [{ id: 'm', name: 'Model', category: 'model', type: 'select', value: 'grok-4.7' }],
      },
    ].map((event, seq) => ({ seq, event: { sessionId: 's', at: 1, ...event } as SessionEvent })),
  ])
  expect(lastUsedModel(segments, 'grok')?.model).toBe('grok-4.7')
})
