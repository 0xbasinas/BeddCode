import { readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { GcReport, GcSessionReport, SessionEvent } from '@beddcode/contracts'
import type { Logger } from '@beddcode/shared'
import { digest } from './automation/digest.ts'
import { liveWorktreeDirs, staleWorktrees } from './telemetry/hostMetrics.ts'
import type { AttachmentStore } from './attachments/store.ts'
import type { EventStore } from './store/eventStore.ts'
import type { GitService } from './workspace/git.ts'

export interface HousekeepingDeps {
  store: EventStore
  /** Deletes a session and its log entries; removes its worktree when asked and clean. */
  sessions: {
    delete(sessionId: string): Promise<void>
    removeWorktree(sessionId: string): Promise<boolean>
  }
  attachments: AttachmentStore
  /** Project folders, to find worktrees whose session is gone. */
  projects: () => Promise<{ path: string }[]>
  git?: Pick<GitService, 'removeWorktree'>
  log: Logger
  now?: () => number
}

export interface GcOptions {
  /** Sessions whose last activity is older than this many days are removed. Default 30. */
  days?: number
  dryRun?: boolean
  /** Also remove removed sessions' worktrees (only when they have no uncommitted files). */
  worktrees?: boolean
  /** Reclaim database space afterwards. Default true. */
  vacuum?: boolean
}

const DAY_MS = 86_400_000

/** Whether a session is pinned (its latest `session.pinned` event). */
function isPinned(events: { event: SessionEvent }[]): boolean {
  const event = events.findLast((s) => s.event.type === 'session.pinned')?.event
  return event?.type === 'session.pinned' ? event.pinned : false
}

/** Whether a session has an approval or question still waiting for an answer. */
function hasOpenRequest(events: { event: SessionEvent }[]): boolean {
  const open = new Set<string>()
  for (const { event } of events) {
    if (event.type === 'approval.requested' || event.type === 'question.requested')
      open.add(event.requestId)
    else if (event.type === 'approval.resolved' || event.type === 'question.resolved')
      open.delete(event.requestId)
  }
  return open.size > 0
}

/**
 * Housekeeping a long-running host needs on its own: delete sessions that have been quiet for
 * `days` days (never one that is running, waiting on the user, or pinned), optionally remove their
 * worktrees, drop attachments no remaining event references, and vacuum the log so the space
 * comes back. With `dryRun`, nothing is changed — the report says what would happen.
 */
export async function garbageCollect(
  deps: HousekeepingDeps,
  options: GcOptions = {},
): Promise<GcReport> {
  const now = deps.now ?? Date.now
  const days = options.days ?? 30
  const cutoff = now() - days * DAY_MS
  const dryRun = options.dryRun === true
  const vacuum = options.vacuum ?? true
  const report: GcReport = {
    dryRun: options.dryRun === true,
    cutoff,
    sessions: [],
    sessionsRemoved: 0,
    worktreesRemoved: 0,
    attachmentsRemoved: 0,
    attachmentBytesFreed: 0,
    dbBytesBefore: deps.store.fileBytes(),
    dbBytesAfter: deps.store.fileBytes(),
    vacuumed: false,
  }

  const live = liveWorktreeDirs(deps.store)
  for (const { id } of deps.store.listSessionIds(Number.MAX_SAFE_INTEGER, 100_000)) {
    const events = deps.store.readSession(id)
    const d = digest(events)
    if (!d) continue
    const lastActiveAt = events.reduce((max, s) => Math.max(max, s.event.at), 0)
    const created = events.find((s) => s.event.type === 'session.created')?.event
    const worktree =
      created?.type === 'session.created' && created.worktree
        ? path.resolve(created.cwd)
        : undefined
    const pinned = isPinned(events)
    const entry: GcSessionReport = {
      id,
      title: d.title,
      lastActiveAt,
      status: d.status,
      ...(worktree ? { worktree } : {}),
      pinned,
      removed: false,
    }
    // Never touch a session that is alive or could still matter: running turns, open approvals or
    // questions, pinned sessions, and anything touched since the cutoff.
    const keep =
      d.status === 'running' ||
      d.status === 'needs-you' ||
      d.status === 'starting' ||
      hasOpenRequest(events) ||
      pinned ||
      lastActiveAt >= cutoff
    if (keep) {
      report.sessions.push({ ...entry, removed: false })
      continue
    }
    // Older than the cutoff and quiet: a candidate.
    if (options.worktrees && worktree) {
      if (!dryRun) {
        try {
          if (await deps.sessions.removeWorktree(id)) report.worktreesRemoved++
        } catch (err) {
          entry.note = `worktree kept: ${err instanceof Error ? err.message : String(err)}`
        }
      } else {
        entry.note = 'worktree would be removed when clean'
      }
    }
    if (!dryRun) {
      await deps.sessions.delete(id)
      live.delete(worktree ?? '')
    }
    entry.removed = true
    report.sessionsRemoved++
    report.sessions.push(entry)
  }

  // Attachments no remaining event references, older than the cutoff.
  const referenced = referencedAttachmentIds(deps.store, deps.attachments.root)
  const removed = await sweepAttachments(deps.attachments.root, referenced, cutoff, dryRun)
  report.attachmentsRemoved = removed.count
  report.attachmentBytesFreed = removed.bytes

  // Worktree folders whose session is gone entirely (crashed host, deleted project).
  if (options.worktrees && deps.git) {
    const projects = await deps.projects().catch(() => [])
    for (const stale of staleWorktrees(
      projects.map((p) => p.path),
      live,
    )) {
      if (dryRun) {
        report.worktreesRemoved++
        continue
      }
      try {
        if (await deps.git.removeWorktree(stale)) report.worktreesRemoved++
      } catch (err) {
        deps.log.warn(`gc: could not remove stale worktree ${stale}`, err)
      }
    }
  }

  if (vacuum && !dryRun) {
    const { after } = deps.store.vacuum()
    report.vacuumed = true
    report.dbBytesAfter = after
  }
  return report
}

/** The attachment ids and paths any stored event still points at. */
function referencedAttachmentIds(store: EventStore, attachmentsRoot: string): Set<string> {
  const referenced = new Set<string>()
  const root = path.resolve(attachmentsRoot)
  for (let after = 0; ;) {
    const batch = store.readAfter(after, 5000)
    if (batch.length === 0) break
    after = batch[batch.length - 1]!.seq
    for (const stored of batch) {
      const payload = JSON.stringify(stored.event)
      for (const match of payload.matchAll(/"path":"((?:[^"\\]|\\.)*)"/g)) {
        try {
          const p = JSON.parse(`"${match[1]}"`) as string
          if (path.resolve(p).startsWith(root)) referenced.add(path.basename(path.dirname(p)))
        } catch {
          // not a real path; ignore
        }
      }
      for (const match of payload.matchAll(/"id":"([a-f0-9-]{36})"/gi)) referenced.add(match[1]!)
    }
  }
  return referenced
}

/** Removes attachment folders older than `cutoff` that nothing references; counts what went. */
async function sweepAttachments(
  root: string,
  referenced: Set<string>,
  cutoff: number,
  dryRun: boolean,
): Promise<{ count: number; bytes: number }> {
  let count = 0
  let bytes = 0
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return { count, bytes }
  }
  for (const entry of entries) {
    if (referenced.has(entry)) continue
    const dir = path.join(root, entry)
    let info
    try {
      info = statSync(dir)
    } catch {
      continue
    }
    if (!info.isDirectory()) continue
    // The folder's own mtime is when its last file was written.
    if (info.mtimeMs >= cutoff) continue
    let size = 0
    try {
      for (const f of readdirSync(dir)) {
        try {
          size += statSync(path.join(dir, f)).size
        } catch {
          // already gone
        }
      }
    } catch {
      continue
    }
    if (!dryRun) await rm(dir, { recursive: true, force: true })
    count++
    bytes += size
  }
  return { count, bytes }
}
