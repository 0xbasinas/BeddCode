import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostInfo } from '@beddcode/contracts'
import { createLogger } from '@beddcode/shared'
import { EventStore } from '../store/eventStore.ts'
import { dirBytes, HostMetrics, liveWorktreeDirs, staleWorktrees } from './hostMetrics.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const host: HostInfo = {
  hostId: 'h1',
  name: 'test-host',
  platform: 'linux',
  version: '0.0.0-test',
}

function makeMetrics(
  store: EventStore,
  extra: Partial<ConstructorParameters<typeof HostMetrics>[0]> = {},
) {
  const m = new HostMetrics({
    store,
    host,
    startedAt: 1_000_000,
    now: () => 1_000_000 + 95_000, // up 95s
    activeTurns: () => 1,
    activeTools: () => 2,
    ...extra,
  })
  m.start()
  return m
}

const created = (sessionId: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'session.created',
    sessionId,
    at: 10,
    title: `t-${sessionId}`,
    cwd: '/w',
    instanceId: 'claude',
    ...extra,
  }) as const

describe('HostMetrics', () => {
  it('counts events since start and reads gauges on demand', async () => {
    const store = new EventStore(':memory:', createLogger('test', 'error'))
    try {
      const m = makeMetrics(store)
      store.append(created('s1') as never)
      store.append({ type: 'turn.started', sessionId: 's1', at: 11 } as never)
      store.append({
        type: 'approval.requested',
        sessionId: 's1',
        at: 12,
        requestId: 'r1',
        title: 'Edit file?',
        options: [{ id: 'a', label: 'Allow', kind: 'allow' }],
      } as never)
      store.append({
        type: 'prompt.queued',
        sessionId: 's1',
        at: 13,
        queueId: 'q1',
        text: 'hi',
      } as never)
      store.append({ type: 'turn.completed', sessionId: 's1', at: 14, reason: 'done' } as never)
      store.append(created('s2', { worktree: { baseBranch: 'main' }, cwd: '/w/.wt/s2' }) as never)
      store.append({ type: 'session.pinned', sessionId: 's2', at: 15, pinned: true } as never)
      store.append({ type: 'session.deleted', sessionId: 's2', at: 16 } as never)

      const stats = await m.snapshot()
      expect(stats.uptimeSeconds).toBe(95)
      expect(stats.seq).toBe(8)
      expect(stats.counters.sessions_created).toBe(2)
      expect(stats.counters.worktrees_created).toBe(1)
      expect(stats.counters.sessions_deleted).toBe(1)
      expect(stats.counters.turns_started).toBe(1)
      expect(stats.counters['turns_completed{reason="done"}']).toBe(1)
      expect(stats.counters.approvals_requested).toBe(1)
      expect(stats.counters.prompts_queued).toBe(1)
      expect(stats.sessions.total).toBe(2)
      // s2 was deleted but its events are still in the log here; status comes from the digest.
      expect(stats.sessions.byStatus.idle).toBe(2)
      expect(stats.sessions.openRequests).toBe(1)
      expect(stats.sessions.queuedPrompts).toBe(1)
      expect(stats.sessions.pinned).toBe(1)
      expect(stats.sessions.activeTurns).toBe(1)
      expect(stats.sessions.activeTools).toBe(2)
      m.stop()
    } finally {
      store.close()
    }
  })

  it('renders Prometheus text with counters, gauges and labels', async () => {
    const store = new EventStore(':memory:', createLogger('test', 'error'))
    try {
      const m = makeMetrics(store)
      store.append(created('s1') as never)
      store.append({ type: 'turn.completed', sessionId: 's1', at: 11, reason: 'error' } as never)
      const text = await m.renderPrometheus()
      expect(text).toContain('# TYPE beddcode_uptime_seconds gauge')
      expect(text).toContain('beddcode_uptime_seconds 95')
      expect(text).toContain('beddcode_sessions{status="error"} 1')
      expect(text).toContain('beddcode_sessions_total 1')
      expect(text).toContain('beddcode_active_turns 1')
      expect(text).toContain('# TYPE beddcode_sessions_created_total counter')
      expect(text).toContain('beddcode_sessions_created_total 1')
      expect(text).toContain('beddcode_turns_completed_total{reason="error"} 1')
      expect(text).toContain('beddcode_db_bytes ')
      m.stop()
    } finally {
      store.close()
    }
  })

  it('escapes label values in the Prometheus output', async () => {
    const store = new EventStore(':memory:', createLogger('test', 'error'))
    try {
      const m = makeMetrics(store)
      store.append({ type: 'turn.completed', sessionId: 's1', at: 11, reason: 'done' } as never)
      const text = await m.renderPrometheus()
      expect(text).toContain('reason="done"')
      m.stop()
    } finally {
      store.close()
    }
  })
})

describe('dirBytes', () => {
  it('sums files, skipping .git and node_modules', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-bytes-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, '.git'), { recursive: true })
    mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, '.git', 'big'), 'x'.repeat(1000))
    writeFileSync(path.join(dir, 'node_modules', 'x', 'big'), 'x'.repeat(1000))
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'x'.repeat(10))
    expect(dirBytes(dir)).toBe(10)
  })
})

describe('staleWorktrees / liveWorktreeDirs', () => {
  it('tells worktree folders still used by a session apart from stale ones', () => {
    const proj = mkdtempSync(path.join(os.tmpdir(), 'beddcode-wt-'))
    dirs.push(proj)
    mkdirSync(path.join(proj, '.wt', 'keep'), { recursive: true })
    mkdirSync(path.join(proj, '.wt', 'gone'), { recursive: true })
    const store = new EventStore(':memory:', createLogger('test', 'error'))
    try {
      const keepDir = path.join(proj, '.wt', 'keep')
      store.append(created('s1', { worktree: { baseBranch: 'main' }, cwd: keepDir }) as never)
      const live = liveWorktreeDirs(store)
      expect([...live]).toEqual([path.resolve(keepDir)])

      const stale = staleWorktrees([proj], live)
      expect(stale).toEqual([path.resolve(path.join(proj, '.wt', 'gone'))])
    } finally {
      store.close()
    }
  })
})
