import {
  buildBlocks,
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

export interface TouchedFile {
  path: string
  added: number
  removed: number
}

/**
 * Files the worker changed: what the host recorded per turn, else the agent's own diffs (the same
 * data the thread list's +/- comes from), minus changes that were undone.
 */
export function touchedFiles(worker?: SessionView): TouchedFile[] {
  if (!worker) return []
  const files = new Map<string, TouchedFile>()
  const add = (path: string, added = 0, removed = 0) => {
    const key = path.replace(/\\/g, '/')
    const file = files.get(key) ?? { path, added: 0, removed: 0 }
    file.added += added
    file.removed += removed
    files.set(key, file)
  }
  for (const block of buildBlocks(worker.items)) {
    if (block.kind === 'edits') for (const f of block.files) add(f.path, f.added, f.removed)
  }
  for (const item of worker.items) {
    if (item.kind === 'changes' && !item.reverted) {
      for (const f of item.files) add(f.path, f.added, f.removed)
    }
  }
  return [...files.values()]
}

/** The model a worker runs on: what it was started with, else the model its agent reports. */
export function workerModel(worker?: SessionView): string | undefined {
  if (!worker) return undefined
  if (worker.model) return worker.model
  const option = worker.config.find((o) => o.category === 'model' && typeof o.value === 'string')
  return option?.choices?.find((c) => c.value === option.value)?.name ?? (option?.value as string)
}
