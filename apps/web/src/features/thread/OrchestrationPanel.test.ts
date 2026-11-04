import { describe, expect, it } from 'vitest'
import type { SessionView } from '@beddcode/client-runtime'
import {
  progressSummary,
  touchedFiles,
  WORKER_STATE_LABEL,
  workerState,
} from './orchestrationModel.ts'

const worker = (patch: Partial<SessionView>): SessionView => ({
  id: 'worker',
  title: 'Worker',
  cwd: '/project',
  projectPath: '/project',
  instanceId: 'agent',
  createdAt: 0,
  updatedAt: 0,
  status: 'idle',
  statusSince: 0,
  items: [],
  added: 0,
  removed: 0,
  turns: 1,
  completedTurns: 1,
  queue: [],
  commands: [],
  config: [],
  ...patch,
})

describe('orchestration worker state', () => {
  it('maps live sessions and absent workers to card states', () => {
    expect(workerState()).toBe('queued')
    expect(workerState(worker({ status: 'running' }))).toBe('running')
    expect(workerState(worker({ status: 'failed' }))).toBe('failed')
    expect(workerState(worker({}))).toBe('done')
    expect(workerState(worker({ lastTurnReason: 'cancelled' }))).toBe('stopped')
  })
  it('shows a worker that needs the user as waiting for approval, not blocked', () => {
    const state = workerState(worker({ status: 'needs-you' }))
    expect(state).toBe('waiting')
    expect(WORKER_STATE_LABEL[state]).toBe('Waiting for approval')
    expect(Object.values(WORKER_STATE_LABEL).join(' ').toLowerCase()).not.toContain('blocked')
  })
  it('uses the worker report when it failed', () => {
    expect(workerState(worker({ result: { status: 'failed', summary: 'Failed' } }))).toBe('failed')
    expect(workerState(worker({ result: { status: 'blocked', summary: 'Waiting' } }))).toBe('done')
  })
})

describe('progress summary', () => {
  it('counts finished workers', () => {
    expect(progressSummary(['done', 'running', 'queued'])).toBe('1 of 3 done')
  })
  it('adds waiting and failed counts', () => {
    expect(progressSummary(['done', 'waiting', 'failed'])).toBe(
      '1 of 3 done · 1 waiting for approval · 1 failed',
    )
  })
})

describe('touched files', () => {
  it('lists changed files once, skipping reverted ones', () => {
    const w = worker({
      items: [
        { kind: 'changes', id: '1', files: [{ path: 'a.ts' }, { path: 'b.ts' }] },
        { kind: 'changes', id: '2', files: [{ path: 'a.ts' }] },
        { kind: 'changes', id: '3', reverted: true, files: [{ path: 'c.ts' }] },
      ] as unknown as SessionView['items'],
    })
    expect(touchedFiles(w)).toEqual(['a.ts', 'b.ts'])
  })
})
