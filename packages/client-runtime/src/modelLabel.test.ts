import { describe, expect, it } from 'vitest'
import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { applyEvent, emptyReplica, type ReplicaState } from './replica.ts'
import { modelDisplayName, prettyModelId, sessionModelId, sessionModelLabel } from './modelLabel.ts'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at'> : never
function fold(events: Draft[]) {
  let state: ReplicaState = emptyReplica()
  events.forEach((e, i) => {
    state = applyEvent(state, {
      seq: i + 1,
      event: { sessionId: 's1', at: i + 1, ...e } as SessionEvent,
    } satisfies StoredEvent)
  })
  return state.sessions.s1!
}

const created = { type: 'session.created' as const, title: 't', cwd: '/w', instanceId: 'claude' }
const grokConfig = {
  type: 'session.config' as const,
  options: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      value: 'grok-4.7',
      choices: [{ value: 'grok-4.7', name: 'Grok 4.7' }],
    },
  ],
}

describe('model labels', () => {
  it('makes readable names from ids', () => {
    expect(prettyModelId('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5')
    expect(prettyModelId('claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5')
    expect(prettyModelId('grok-4.7')).toBe('Grok 4.7')
  })

  it('prefers the agent’s listed label, then config choices', () => {
    expect(modelDisplayName([{ id: 'x', label: 'Ex' }], 'x')).toBe('Ex')
    expect(modelDisplayName([], undefined)).toBeUndefined()
    expect(modelDisplayName([], 'grok-4.7', grokConfig.options)).toBe('Grok 4.7')
  })

  it('knows the model of a session created with one', () => {
    const s = fold([{ ...created, model: 'claude-sonnet-5-5' }])
    expect(sessionModelLabel(s, [])).toBe('Claude Sonnet 5.5')
  })

  it('is unknown only when nothing says', () => {
    expect(sessionModelLabel(fold([created]), [])).toBeUndefined()
  })

  it('learns the model from usage when nothing else says', () => {
    const s = fold([
      created,
      {
        type: 'session.usage',
        model: 'claude-sonnet-5-5',
        inputTokens: 1,
        outputTokens: 1,
      },
    ])
    expect(sessionModelLabel(s, [])).toBe('Claude Sonnet 5.5')
  })

  it('keeps the model through Claude -> Grok -> Claude -> Grok', () => {
    const events: Draft[] = [
      { ...created, model: 'claude-sonnet-5-5' },
      { type: 'session.switched', instanceId: 'grok', handoff: 'h' },
      grokConfig,
      { type: 'session.switched', instanceId: 'claude', model: 'claude-sonnet-5-5', handoff: 'h' },
    ]
    const back = fold(events)
    expect(sessionModelLabel(back, [])).toBe('Claude Sonnet 5.5')
    // The server records Grok's last-used model; Grok itself emits no fresh config.
    const again = fold([
      ...events,
      { type: 'session.switched', instanceId: 'grok', model: 'grok-4.7', handoff: 'h' },
    ])
    expect(again.config).toEqual([])
    expect(sessionModelLabel(again, [])).toBe('Grok 4.7')
  })

  it('records a config-reported model on the segment so a later switch can resume it', () => {
    const s = fold([
      created,
      { type: 'session.switched', instanceId: 'grok', handoff: 'h' },
      grokConfig,
    ])
    expect(s.segments?.at(-1)?.model).toBe('grok-4.7')
    expect(sessionModelId(s)).toBe('grok-4.7')
  })
})
