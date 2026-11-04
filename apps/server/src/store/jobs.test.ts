import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EventStore } from './eventStore.ts'

const limits = { kinds: ['task'], leaseMs: 100, hostLimit: 2, projectLimit: 1 }

describe('durable jobs', () => {
  it('survives reopening and interrupts running jobs on host recovery', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jobs-'))
    try {
      const file = path.join(dir, 'events.db')
      const first = new EventStore(file)
      const a = first.jobs.enqueue({ kind: 'task', payload: { text: 'a' } }, 1)
      const b = first.jobs.enqueue({ kind: 'task', payload: { text: 'b' } }, 2)
      const lease = first.jobs.claim(limits, 3)!
      expect(lease.id).toBe(a.id)
      first.close()
      const second = new EventStore(file)
      expect(second.jobs.recover(4)).toBe(1)
      expect(second.jobs.get(a.id)).toMatchObject({
        state: 'interrupted',
        attempts: 1,
        payload: { text: 'a' },
      })
      expect(second.jobs.get(b.id)?.state).toBe('queued')
      expect(second.jobs.finish(a.id, lease.leaseToken!, 'completed', null, 5)).toBe(false)
      expect(second.jobs.retry(a.id, 6)).toBe(true)
      expect(second.jobs.claim(limits, 7)?.id).toBe(b.id)
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces limits, fences expired leases, and supports reorder and cancellation', () => {
    const store = new EventStore(':memory:')
    const a = store.jobs.enqueue({ kind: 'task', payload: 1, project: 'p' }, 1)
    const b = store.jobs.enqueue({ kind: 'task', payload: 2, project: 'p' }, 2)
    const c = store.jobs.enqueue({ kind: 'task', payload: 3, project: 'q' }, 3)
    expect(store.jobs.move(c.id, 'up', 4)).toBe(true)
    const first = store.jobs.claim(limits, 5)!
    const second = store.jobs.claim(limits, 6)!
    expect([first.id, second.id]).toEqual([a.id, c.id])
    expect(store.jobs.claim(limits, 7)).toBeUndefined()
    expect(store.jobs.renew(a.id, first.leaseToken!, 100, 50)).toBe(true)
    expect(store.jobs.finish(c.id, second.leaseToken!, 'failed', 'failed', 7)).toBe(true)
    expect(store.jobs.claim(limits, 8)).toBeUndefined()
    expect(store.jobs.expire(150)).toBe(1)
    expect(store.jobs.finish(a.id, first.leaseToken!, 'completed', null, 150)).toBe(false)
    expect(store.jobs.cancel(b.id, 151)).toBe(true)
    expect(store.jobs.retry(c.id, 152)).toBe(true)
    const retry = store.jobs.claim(limits, 153)!
    expect(retry).toMatchObject({ id: c.id, attempts: 2 })
    expect(store.jobs.finish(c.id, retry.leaseToken!, 'completed', null, 154)).toBe(true)
    store.close()
  })
})
