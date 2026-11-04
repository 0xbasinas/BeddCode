import { describe, expect, it, vi } from 'vitest'
import { createFakeAdapter } from '@beddcode/provider-core'
import {
  buildSummary,
  NotificationThrottle,
  OrchestrationFinish,
  recoveryAgent,
} from './orchestrationFinish.ts'
import type { SessionEvent, StoredEvent } from '@beddcode/contracts'

describe('orchestration finish', () => {
  it('builds a concise summary with changes and duration', () => {
    expect(
      buildSummary('Ship', [
        {
          agent: 'fake',
          status: 'finished',
          result: 'Done',
          files: ' a.ts | 2 ++',
          duration: 2400,
        },
      ]),
    ).toContain('fake: finished (2s)\n  Done\n  Changes:  a.ts | 2 ++')
  })
  it('throttles each group independently', () => {
    const throttle = new NotificationThrottle()
    expect(throttle.allow('a', 0)).toBe(true)
    expect(throttle.allow('a', 9999)).toBe(false)
    expect(throttle.allow('b', 1)).toBe(true)
    expect(throttle.allow('a', 10000)).toBe(true)
  })
  it('chooses a retry or a different ready provider for handoff', () => {
    const providers = [
      { id: 'fake', status: 'ready' as const },
      { id: 'other', status: 'ready' as const },
    ]
    expect(createFakeAdapter()).toBeDefined()
    expect(recoveryAgent('none', 'fake', providers)).toBeUndefined()
    expect(recoveryAgent('retry-once', 'fake', providers)).toBe('fake')
    expect(recoveryAgent('handoff', 'fake', providers)).toBe('other')
    expect(recoveryAgent('handoff', 'fake', providers.slice(0, 1))).toBeUndefined()
  })
  it('delivers one summary after the fake worker finishes and replays it on recovery', async () => {
    const logs = new Map<string, StoredEvent[]>()
    const append = (event: SessionEvent) =>
      logs.set(event.sessionId, [...(logs.get(event.sessionId) ?? []), { seq: 1, event }])
    append({
      type: 'session.created',
      sessionId: 'lead',
      at: 0,
      title: 'Lead',
      cwd: '/p',
      instanceId: 'fake',
    })
    append({
      type: 'orchestration.plan',
      sessionId: 'lead',
      at: 1,
      planId: 'p',
      goal: 'Ship',
      tasks: [{ id: 't', agent: 'fake', prompt: 'Work', worktree: false }],
    })
    append({
      type: 'session.created',
      sessionId: 'worker',
      at: 2,
      title: 'Worker',
      cwd: '/p',
      instanceId: 'fake',
      parent: { sessionId: 'lead', depth: 1, requestId: 'plan:p:t' },
    })
    append({ type: 'turn.started', sessionId: 'worker', at: 3 })
    append({ type: 'session.result', sessionId: 'worker', at: 4, status: 'done', summary: 'Done' })
    append({ type: 'turn.completed', sessionId: 'worker', at: 1003, reason: 'done' })
    const deliver = vi.fn()
    const finish = new OrchestrationFinish({
      read: (id) => logs.get(id) ?? [],
      children: () => ['worker'],
      append: (event) => {
        append(event)
      },
      providers: async () => [],
      limits: () => ({
        maxDepth: 2,
        maxWorkers: 5,
        maxTotalWorkers: 10,
        maxMessagesPerMinute: 10,
        maxMessages: 50,
        approval: 'off',
      }),
      start: async () => {},
      diff: async () => 'a.ts | 1 +',
      deliver,
    })
    finish.reconcile('lead')
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    expect(
      logs.get('lead')?.filter(({ event }) => event.type === 'orchestration.summary'),
    ).toHaveLength(1)
    expect(deliver.mock.calls[0]?.[2]).toContain('a.ts | 1 +')
    finish.reconcile('lead')
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
    expect(
      logs.get('lead')?.filter(({ event }) => event.type === 'orchestration.summary'),
    ).toHaveLength(1)
  })
})
