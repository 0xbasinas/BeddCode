import { describe, expect, it } from 'vitest'
import type { SessionView } from '@beddcode/client-runtime'
import { workerStatus } from './OrchestrationPanel.tsx'

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

describe('orchestration worker status', () => {
  it('maps live sessions and absent workers to task statuses', () => {
    expect(workerStatus()).toBe('queued')
    expect(workerStatus(worker({ status: 'running' }))).toBe('working')
    expect(workerStatus(worker({ status: 'needs-you' }))).toBe('blocked')
    expect(workerStatus(worker({ status: 'failed' }))).toBe('failed')
    expect(workerStatus(worker({}))).toBe('done')
    expect(workerStatus(worker({ lastTurnReason: 'cancelled' }))).toBe('failed')
  })
  it('uses the worker report when it exists', () => {
    expect(workerStatus(worker({ result: { status: 'blocked', summary: 'Waiting' } }))).toBe(
      'blocked',
    )
    expect(workerStatus(worker({ result: { status: 'failed', summary: 'Failed' } }))).toBe('failed')
  })
})
