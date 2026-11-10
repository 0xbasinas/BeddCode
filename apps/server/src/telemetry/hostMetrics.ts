import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { HostInfo, HostStats, StoredEvent } from '@beddcode/contracts'
import { digest, type DigestStatus } from '../automation/digest.ts'
import type { EventStore } from '../store/eventStore.ts'

export interface HostMetricsDeps {
  store: EventStore
  host: HostInfo
  /** Epoch ms the host process started; defaults to now. */
  startedAt?: number
  now?: () => number
  activeTurns?: () => number
  activeTools?: () => number
  /** Open websocket connections, for the client gauge. */
  wsClients?: () => number
  /** Where uploads live, for the attachments gauge. */
  attachmentsRoot?: string
  /** Project folders, to find worktrees whose session is gone. */
  projects?: () => string[] | Promise<string[]>
  /** The event-log database file, for its size. Defaults to the store's own file. */
  dbFile?: string
}

interface Counter {
  name: string
  labels: Record<string, string>
  value: number
}

const STATUSES: DigestStatus[] = ['starting', 'running', 'needs-you', 'idle', 'error', 'cancelled']

/** Folders never worth walking when summing sizes or watching for changes. */
export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.wt',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'target',
])

/** Sums the files under `dir`, stopping at `cap` entries so a huge tree cannot stall a scrape. */
export function dirBytes(dir: string, cap = 50_000): number {
  let total = 0
  let seen = 0
  const walk = (current: string) => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      if (++seen > cap) return
      const full = path.join(current, entry)
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) walk(full)
      } else if (info.isFile()) {
        total += info.size
      }
    }
  }
  walk(dir)
  return total
}

/** Lists the worktree folders under every project's `.wt/` that no session uses anymore. */
export function staleWorktrees(projects: string[], liveDirs: Set<string>): string[] {
  const stale: string[] = []
  for (const project of projects) {
    const wtRoot = path.join(project, '.wt')
    let entries: string[]
    try {
      entries = readdirSync(wtRoot)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(wtRoot, entry)
      try {
        if (!statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      const resolved = path.resolve(full)
      if (!liveDirs.has(resolved)) stale.push(resolved)
    }
  }
  return stale
}

/** The cwd of every session that works in a worktree: the worktrees that are still in use. */
export function liveWorktreeDirs(store: EventStore): Set<string> {
  const live = new Set<string>()
  for (const { id } of store.listSessionIds(Number.MAX_SAFE_INTEGER, 100_000)) {
    const created = store.readSession(id).find((s) => s.event.type === 'session.created')?.event
    if (created?.type === 'session.created' && created.worktree) live.add(path.resolve(created.cwd))
  }
  return live
}

/**
 * Counts what the host does, since it started, and reads its current gauges on demand. The same
 * numbers go to `host.stats` (JSON) and `GET /metrics` (Prometheus text), so a dashboard can watch
 * a host the way one watches any other service.
 */
export class HostMetrics {
  private readonly counters = new Map<string, Counter>()
  private unsubscribe: (() => void) | undefined
  private readonly now: () => number

  constructor(private readonly deps: HostMetricsDeps) {
    this.now = deps.now ?? Date.now
  }

  private wsCounter: (() => number) | undefined

  /** Called by the transport once it knows how many websocket connections are open. */
  setWsClients(fn: () => number) {
    this.wsCounter = fn
  }

  /** Starts counting the event log. Call once the store is open. */
  start() {
    this.unsubscribe = this.deps.store.subscribe((stored) => this.onEvent(stored))
  }

  stop() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  private inc(name: string, labels: Record<string, string> = {}) {
    const key = `${name}|${JSON.stringify(labels)}`
    const found = this.counters.get(key)
    if (found) found.value++
    else this.counters.set(key, { name, labels, value: 1 })
  }

  private onEvent(stored: StoredEvent) {
    const e = stored.event
    switch (e.type) {
      case 'session.created':
        this.inc('sessions_created')
        if (e.worktree) this.inc('worktrees_created')
        break
      case 'session.deleted':
        this.inc('sessions_deleted')
        break
      case 'turn.started':
        this.inc('turns_started')
        break
      case 'turn.completed':
        this.inc('turns_completed', { reason: e.reason })
        break
      case 'turn.reverted':
        this.inc('turns_undone')
        break
      case 'approval.requested':
        this.inc('approvals_requested')
        break
      case 'approval.resolved':
        this.inc('approvals_resolved')
        break
      case 'question.requested':
        this.inc('questions_requested')
        break
      case 'question.resolved':
        this.inc('questions_resolved')
        break
      case 'prompt.queued':
        this.inc('prompts_queued')
        break
      case 'prompt.dequeued':
        this.inc('prompts_dequeued', { reason: e.reason })
        break
      case 'message.delta':
        if (e.role === 'user') this.inc('messages_sent')
        break
      default:
        break
    }
  }

  /** Reads the sessions from the log: how many, in which state, what is waiting on the user. */
  sessionStats(): HostStats['sessions'] {
    const byStatus: Record<string, number> = {}
    for (const s of STATUSES) byStatus[s] = 0
    let openRequests = 0
    let queuedPrompts = 0
    let pinned = 0
    let total = 0
    for (const { id } of this.deps.store.listSessionIds(Number.MAX_SAFE_INTEGER, 100_000)) {
      const events = this.deps.store.readSession(id)
      const d = digest(events)
      if (!d) continue
      total++
      byStatus[d.status] = (byStatus[d.status] ?? 0) + 1
      if (d.status === 'needs-you') openRequests++
      const pinnedEvent = events.findLast((s) => s.event.type === 'session.pinned')?.event
      if (pinnedEvent?.type === 'session.pinned' && pinnedEvent.pinned) pinned++
      for (const { event } of events) {
        if (event.type === 'prompt.queued') queuedPrompts++
        else if (event.type === 'prompt.dequeued') queuedPrompts--
        else if (event.type === 'approval.requested' || event.type === 'question.requested')
          openRequests++
        else if (event.type === 'approval.resolved' || event.type === 'question.resolved')
          openRequests--
      }
    }
    return {
      total,
      byStatus: byStatus as HostStats['sessions']['byStatus'],
      activeTurns: this.deps.activeTurns?.() ?? 0,
      activeTools: this.deps.activeTools?.() ?? 0,
      openRequests: Math.max(0, openRequests),
      queuedPrompts: Math.max(0, queuedPrompts),
      pinned,
    }
  }

  /** How much the data folder weighs, and which worktrees no session uses anymore. */
  async storage(): Promise<HostStats['storage']> {
    const projects = (await this.deps.projects?.()) ?? []
    return {
      dbBytes: this.deps.store.fileBytes(),
      attachmentsBytes: this.deps.attachmentsRoot ? dirBytes(this.deps.attachmentsRoot) : 0,
      staleWorktrees: staleWorktrees(projects, liveWorktreeDirs(this.deps.store)),
    }
  }

  /** The light storage hint `/health` carries for this machine (see `beddcode doctor`). */
  storageHint(): Promise<HostStats['storage']> {
    return this.storage()
  }

  /** The full snapshot behind `host.stats` and `/metrics`. */
  async snapshot(): Promise<HostStats> {
    return {
      host: this.deps.host,
      uptimeSeconds: Math.max(
        0,
        Math.floor((this.now() - (this.deps.startedAt ?? this.now())) / 1000),
      ),
      seq: this.deps.store.lastSeq(),
      counters: Object.fromEntries(
        [...this.counters.values()].map((c) => [
          c.labels && Object.keys(c.labels).length > 0
            ? `${c.name}{${Object.entries(c.labels)
                .map(([k, v]) => `${k}="${v}"`)
                .join(',')}}`
            : c.name,
          c.value,
        ]),
      ),
      sessions: this.sessionStats(),
      storage: await this.storage(),
      clients: { websockets: this.deps.wsClients?.() ?? this.wsCounter?.() ?? 0 },
    }
  }

  /** The snapshot as Prometheus text exposition format (version 0.0.4). */
  async renderPrometheus(): Promise<string> {
    const stats = await this.snapshot()
    const lines: string[] = []
    // Each sample line is `<labels> <value>`; the metric name is prefixed here.
    const emit = (type: string, name: string, help: string, samples: string[]) => {
      lines.push(
        `# HELP beddcode_${name} ${help}`,
        `# TYPE beddcode_${name} ${type}`,
        ...samples.map((s) => `beddcode_${name}${s.startsWith('{') ? s : ` ${s.trimStart()}`}`),
      )
    }
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
    const labeled = (labels: Record<string, string>) =>
      Object.keys(labels).length > 0
        ? `{${Object.entries(labels)
            .map(([k, v]) => `${k}="${esc(v)}"`)
            .join(',')}}`
        : ''

    emit('gauge', 'uptime_seconds', 'Seconds since the host process started.', [
      `${stats.uptimeSeconds}`,
    ])
    emit('gauge', 'event_seq', 'Last sequence number in the host event log.', [`${stats.seq}`])
    emit(
      'gauge',
      'sessions',
      'Sessions by status.',
      STATUSES.map((s) => `${labeled({ status: s })} ${stats.sessions.byStatus[s] ?? 0}`),
    )
    emit('gauge', 'sessions_total', 'Sessions in the log.', [`${stats.sessions.total}`])
    emit('gauge', 'sessions_pinned', 'Pinned sessions.', [`${stats.sessions.pinned}`])
    emit('gauge', 'active_turns', 'Turns running right now.', [`${stats.sessions.activeTurns}`])
    emit('gauge', 'active_tools', 'Tool calls running right now.', [
      `${stats.sessions.activeTools}`,
    ])
    emit('gauge', 'open_requests', 'Approvals and questions waiting for an answer.', [
      `${stats.sessions.openRequests}`,
    ])
    emit('gauge', 'queued_prompts', 'Messages queued behind a running turn.', [
      `${stats.sessions.queuedPrompts}`,
    ])
    emit('gauge', 'ws_clients', 'Open websocket connections.', [`${stats.clients.websockets}`])
    emit('gauge', 'db_bytes', 'Size of the event-log database file.', [`${stats.storage.dbBytes}`])
    emit('gauge', 'attachments_bytes', 'Size of all stored attachments.', [
      `${stats.storage.attachmentsBytes}`,
    ])
    emit('gauge', 'stale_worktrees', 'Worktree folders whose session no longer exists.', [
      `${stats.storage.staleWorktrees.length}`,
    ])
    const counters = [...this.counters.values()].sort((a, b) => a.name.localeCompare(b.name))
    const byName = new Map<string, Counter[]>()
    for (const c of counters) {
      const list = byName.get(c.name) ?? []
      list.push(c)
      byName.set(c.name, list)
    }
    for (const [name, list] of byName) {
      emit(
        'counter',
        `${name}_total`,
        `How many times ${name.replace(/_/g, ' ')} happened since the host started.`,
        list.map((c) => `${labeled(c.labels)} ${c.value}`),
      )
    }
    return `${lines.join('\n')}\n`
  }
}
