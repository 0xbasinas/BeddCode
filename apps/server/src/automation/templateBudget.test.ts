import { expect, it, vi } from 'vitest'
import type { StoredEvent } from '@beddcode/contracts'
import { TemplateBudgetWatcher } from './templateBudget.ts'

it('interrupts and records workers that exceed turn or elapsed budgets', async () => {
  vi.useFakeTimers()
  try {
    let listener!: (event: StoredEvent) => void
    const interrupt = vi.fn(async () => {})
    const report = vi.fn()
    const watcher = new TemplateBudgetWatcher({
      subscribe: (fn) => {
        listener = fn
        return () => {}
      },
      interrupt,
      report,
    })
    watcher.watch('turns', { turnCap: 1 })
    listener({ event: { type: 'turn.started', sessionId: 'turns', at: Date.now() } } as StoredEvent)
    expect(interrupt).not.toHaveBeenCalled()
    listener({ event: { type: 'turn.started', sessionId: 'turns', at: Date.now() } } as StoredEvent)
    watcher.watch('time', { timeBudgetSeconds: 60 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(interrupt.mock.calls).toEqual([['turns'], ['time']])
    expect(report.mock.calls).toEqual([['turns'], ['time']])
    watcher.stop()
  } finally {
    vi.useRealTimers()
  }
})
