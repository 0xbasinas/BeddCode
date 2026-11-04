import type { StoredEvent } from '@beddcode/contracts'

/** Tracks budgets for template workers while the host is running. */
export class TemplateBudgetWatcher {
  private workers = new Map<
    string,
    { turns: number; turnCap?: number; timer?: ReturnType<typeof setTimeout> }
  >()
  private unsubscribe: () => void
  constructor(
    private host: {
      subscribe: (listener: (event: StoredEvent) => void) => () => void
      interrupt: (id: string) => Promise<void>
      report: (id: string) => void
    },
  ) {
    this.unsubscribe = host.subscribe(({ event }) => {
      const worker = this.workers.get(event.sessionId)
      if (!worker) return
      if (event.type === 'turn.started' && ++worker.turns > (worker.turnCap ?? Infinity))
        this.exceed(event.sessionId)
      if (event.type === 'session.result' || event.type === 'session.deleted')
        this.forget(event.sessionId)
    })
  }
  watch(id: string, budget: { turnCap?: number; timeBudgetSeconds?: number }) {
    this.forget(id)
    const worker: { turns: number; turnCap?: number; timer?: ReturnType<typeof setTimeout> } = {
      turns: 0,
      turnCap: budget.turnCap,
    }
    this.workers.set(id, worker)
    if (budget.timeBudgetSeconds)
      worker.timer = setTimeout(() => this.exceed(id), budget.timeBudgetSeconds * 1000)
  }
  private exceed(id: string) {
    if (!this.workers.has(id)) return
    this.forget(id)
    this.host.report(id)
    void this.host.interrupt(id).catch(() => {})
  }
  private forget(id: string) {
    const worker = this.workers.get(id)
    if (worker?.timer) clearTimeout(worker.timer)
    this.workers.delete(id)
  }
  stop() {
    this.unsubscribe()
    for (const id of this.workers.keys()) this.forget(id)
  }
}
