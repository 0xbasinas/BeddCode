import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@beddcode/contracts'
import { EventStore } from '../store/eventStore.ts'
import { dayOf, summarizeUsage, totalTokens } from './summary.ts'

const DAY = 86_400_000
// Noon, so a few hours either way stays on the same local day.
const now = new Date(2026, 9, 22, 12, 0).getTime()

function setup() {
  const store = new EventStore(':memory:')
  const created = (id: string, title: string, extra: Partial<SessionEvent> = {}) =>
    store.append({
      type: 'session.created',
      sessionId: id,
      at: now - 20 * DAY,
      title,
      cwd: '/w',
      instanceId: 'claude',
      ...extra,
    } as SessionEvent)
  const usage = (
    id: string,
    at: number,
    tokens: { inputTokens: number; outputTokens: number } & Record<string, number | string>,
  ) => store.append({ type: 'session.usage', sessionId: id, at, ...tokens } as SessionEvent)
  return { store, created, usage }
}

describe('summarizeUsage', () => {
  it('adds up what each model, session and day used', () => {
    const { store, created, usage } = setup()
    created('a', 'Fix the limiter', { branch: 'fix/limiter' })
    created('b', 'Bump Vite')
    usage('a', now - 1 * DAY, {
      model: 'sonnet',
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.05,
    })
    usage('a', now - 1 * DAY + 1000, {
      model: 'sonnet',
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 4000,
    })
    usage('b', now, { model: 'haiku', inputTokens: 100, outputTokens: 20 })

    const summary = summarizeUsage(store, 7, now)
    expect(summary.totals).toEqual({
      inputTokens: 1600,
      outputTokens: 320,
      cacheReadTokens: 4000,
      cacheWriteTokens: 0,
      costUsd: 0.05,
    })
    expect(summary.byModel.map((m) => [m.model, totalTokens(m)])).toEqual([
      ['sonnet', 5800],
      ['haiku', 120],
    ])
    expect(summary.bySession.map((s) => [s.title, s.branch])).toEqual([
      ['Fix the limiter', 'fix/limiter'],
      ['Bump Vite', undefined],
    ])
    const days = Object.fromEntries(summary.byDay.map((d) => [d.day, totalTokens(d)]))
    expect(days[dayOf(now - DAY)]).toBe(5800)
    expect(days[dayOf(now)]).toBe(120)
  })

  it('lists every day of the period, quiet ones too, oldest first', () => {
    const { store } = setup()
    const summary = summarizeUsage(store, 7, now)
    expect(summary.byDay).toHaveLength(7)
    expect(summary.byDay.at(-1)?.day).toBe(dayOf(now))
    expect(summary.byDay[0]?.day).toBe(dayOf(now - 6 * DAY))
    expect(summary.totals.inputTokens).toBe(0)
  })

  it('leaves out what happened before the period', () => {
    const { store, created, usage } = setup()
    created('a', 'Old')
    usage('a', now - 30 * DAY, { model: 'm', inputTokens: 999, outputTokens: 1 })
    usage('a', now - 2 * DAY, { model: 'm', inputTokens: 10, outputTokens: 1 })
    expect(summarizeUsage(store, 7, now).totals.inputTokens).toBe(10)
    expect(summarizeUsage(store, 90, now).totals.inputTokens).toBe(1009)
  })

  it("files a report that names no model under the session's model, then its agent", () => {
    const { store, created, usage } = setup()
    created('a', 'One', { model: 'gpt-5' })
    created('b', 'Two', { instanceId: 'codex' })
    usage('a', now, { inputTokens: 5, outputTokens: 5 })
    usage('b', now, { inputTokens: 7, outputTokens: 7 })
    const summary = summarizeUsage(store, 7, now, (id) => (id === 'codex' ? 'Codex' : id))
    expect(summary.byModel.map((m) => m.model).sort()).toEqual(['Codex', 'gpt-5'])
  })

  it('follows a rename and a model change in the log', () => {
    const { store, created, usage } = setup()
    created('a', 'Before')
    store.append({ type: 'session.renamed', sessionId: 'a', at: now - DAY, title: 'After' })
    usage('a', now, { model: 'm', inputTokens: 1, outputTokens: 1 })
    expect(summarizeUsage(store, 7, now).bySession[0]?.title).toBe('After')
  })
})

describe('summarizeUsage by agent', () => {
  it('adds up each agent apart, with how many reports it made', () => {
    const { store, created, usage } = setup()
    created('a', 'One')
    created('b', 'Two', { instanceId: 'acp:grok' })
    usage('a', now, { model: 'sonnet', inputTokens: 100, outputTokens: 10 })
    usage('a', now, { model: 'sonnet', inputTokens: 50, outputTokens: 5 })
    usage('b', now, { model: 'grok-4.7', inputTokens: 900, outputTokens: 90, costUsd: 0.02 })
    const label = (id: string) => (id === 'acp:grok' ? 'Grok' : 'Claude Code')
    const summary = summarizeUsage(store, 7, now, label)
    expect(summary.byAgent.map((a) => [a.label, a.reports, totalTokens(a)])).toEqual([
      ['Grok', 1, 990],
      ['Claude Code', 2, 165],
    ])
    expect(summary.byAgent[0]?.costUsd).toBeCloseTo(0.02, 10)
  })

  it('counts a cost-only report (no tokens) for the agent that made it', () => {
    const { store, created, usage } = setup()
    created('b', 'Two', { instanceId: 'acp:x' })
    usage('b', now, { inputTokens: 0, outputTokens: 0, costUsd: 0.04 })
    const summary = summarizeUsage(store, 7, now)
    expect(summary.byAgent[0]).toMatchObject({ instanceId: 'acp:x', reports: 1 })
    expect(summary.totals.costUsd).toBeCloseTo(0.04, 10)
  })
})
