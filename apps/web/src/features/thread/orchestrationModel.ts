import {
  childActivity,
  childPhase,
  latestReply,
  preview,
  type SessionView,
} from '@beddcode/client-runtime'

export type WorkerState = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

export const WORKER_STATE_LABEL: Record<WorkerState, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting for approval',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
}

/** The state a worker card shows; a worker that needs the user is "waiting", never "blocked". */
export function workerState(worker?: SessionView): WorkerState {
  if (!worker) return 'queued'
  const phase = childPhase(worker)
  if (phase === 'needs-you') return 'waiting'
  if (phase === 'running' || phase === 'starting') return 'running'
  if (phase === 'stopped') return 'stopped'
  if (phase === 'failed') return 'failed'
  if (worker.result?.status === 'failed') return 'failed'
  return 'done'
}

export const isActive = (state: WorkerState) => state === 'running' || state === 'waiting'

/** "1 of 3 done", with the number that failed or wait for approval when there are any. */
export function progressSummary(states: WorkerState[]): string {
  const done = states.filter((s) => s === 'done').length
  const parts = [`${done} of ${states.length} done`]
  const failed = states.filter((s) => s === 'failed').length
  const waiting = states.filter((s) => s === 'waiting').length
  if (waiting) parts.push(`${waiting} waiting for approval`)
  if (failed) parts.push(`${failed} failed`)
  return parts.join(' · ')
}

/** One line on what the worker is doing now, or how it ended. */
export function workerActivity(worker?: SessionView): string | undefined {
  if (!worker) return 'Not started yet'
  const state = workerState(worker)
  if (isActive(state)) return preview(childActivity(worker), 120)
  return preview(worker.result?.summary ?? latestReply(worker), 120)
}

/** Files the worker's turns changed and did not undo. */
export function touchedFiles(worker?: SessionView): string[] {
  if (!worker) return []
  const files = new Set<string>()
  for (const item of worker.items) {
    if (item.kind === 'changes' && !item.reverted) for (const f of item.files) files.add(f.path)
  }
  return [...files]
}
