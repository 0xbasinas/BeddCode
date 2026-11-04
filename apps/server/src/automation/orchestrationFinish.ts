import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  OrchestrationLimits,
  ProviderInstance,
  SessionEvent,
  StoredEvent,
} from '@beddcode/contracts'
import { digest, reportedResult } from './digest.ts'

const exec = promisify(execFile)
type Plan = Extract<SessionEvent, { type: 'orchestration.plan' }>
type Recovery = Extract<SessionEvent, { type: 'orchestration.recovery' }>
type Worker = { agent: string; status: string; result: string; files: string; duration: number }

export function buildSummary(goal: string, workers: Worker[]): string {
  return `Orchestration finished: ${goal}\n${workers
    .map(
      (w) =>
        `- ${w.agent}: ${w.status} (${Math.round(w.duration / 1000)}s)\n  ${w.result || 'No result reported'}\n  Changes: ${w.files || 'none'}`,
    )
    .join('\n')}`
}

export function recoveryAgent(
  mode: OrchestrationLimits['onWorkerFailure'],
  failed: string,
  providers: Pick<ProviderInstance, 'id' | 'status'>[],
): string | undefined {
  if (mode === 'retry-once') return failed
  if (mode === 'handoff') return providers.find((p) => p.status === 'ready' && p.id !== failed)?.id
  return undefined
}

/** A per-group window bounds bursts without suppressing later updates indefinitely. */
export class NotificationThrottle {
  private sent = new Map<string, number>()
  allow(group: string, now: number): boolean {
    const last = this.sent.get(group)
    if (last !== undefined && now - last < 10_000) return false
    this.sent.set(group, now)
    return true
  }
}

export async function diffStat(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['diff', '--stat', 'HEAD', '--'], {
      cwd,
      timeout: 5000,
      maxBuffer: 100_000,
    })
    return stdout.trim().slice(0, 4000)
  } catch {
    return 'unavailable'
  }
}

type Host = {
  read(id: string): StoredEvent[]
  children(id: string): string[]
  append(event: SessionEvent): void
  providers(): Promise<ProviderInstance[]>
  limits(project?: string): OrchestrationLimits
  start(parent: string, args: Record<string, unknown>): Promise<unknown>
  deliver(parent: string, planId: string, text: string): void
  diff(cwd: string): Promise<string>
}

/** Reconciles durable plans after worker events and after host restart. */
export class OrchestrationFinish {
  private running = new Set<string>()
  private dirty = new Set<string>()
  private attempted = new Set<string>()
  private throttle = new NotificationThrottle()
  constructor(private host: Host) {}

  onEvent(event: SessionEvent) {
    if (!['turn.completed', 'approval.requested', 'question.requested'].includes(event.type)) return
    const created = this.host
      .read(event.sessionId)
      .find(({ event: e }) => e.type === 'session.created')?.event
    if (!created || created.type !== 'session.created' || !created.parent) return
    const parent = created.parent.sessionId
    const plans = this.host
      .read(parent)
      .map((e) => e.event)
      .filter((e): e is Plan => e.type === 'orchestration.plan')
    const plan = plans.find((p) =>
      p.tasks.some(
        (t) =>
          created.parent?.requestId === `plan:${p.planId}:${t.id}` ||
          created.parent?.requestId === `recovery:${p.planId}:${t.id}`,
      ),
    )
    if (!plan) return
    const kind =
      event.type === 'turn.completed'
        ? event.reason === 'error' ||
          digest(this.host.read(event.sessionId))?.result?.status === 'failed'
          ? 'failed'
          : 'finished'
        : 'approval'
    if (this.throttle.allow(`${parent}:${plan.planId}`, event.at))
      this.host.append({
        type: 'orchestration.notification',
        sessionId: parent,
        at: event.at,
        planId: plan.planId,
        workerId: event.sessionId,
        kind,
      })
    if (event.type === 'turn.completed') this.reconcile(parent)
  }

  reconcile(parent: string) {
    if (this.running.has(parent)) {
      this.dirty.add(parent)
      return
    }
    this.running.add(parent)
    void this.process(parent)
      .catch(() => {})
      .finally(() => {
        this.running.delete(parent)
        if (this.dirty.delete(parent)) this.reconcile(parent)
      })
  }

  private async process(parent: string) {
    const events = this.host.read(parent).map((e) => e.event)
    const plans = events.filter((e): e is Plan => e.type === 'orchestration.plan')
    const parentCreated = events.find((e) => e.type === 'session.created')
    for (const plan of plans) {
      const existing = events.find(
        (e) => e.type === 'orchestration.summary' && e.planId === plan.planId,
      )
      if (existing?.type === 'orchestration.summary') {
        this.host.deliver(parent, plan.planId, existing.text)
        continue
      }
      const children = this.host.children(parent).map((id) => this.host.read(id))
      const find = (request: string) =>
        children.find((rows) =>
          rows.some(
            ({ event }) => event.type === 'session.created' && event.parent?.requestId === request,
          ),
        )
      const workers: Worker[] = []
      let pending = false
      for (const task of plan.tasks) {
        const original = find(`plan:${plan.planId}:${task.id}`)
        if (!original) {
          pending = true
          continue
        }
        const initial = digest(original)
        const initialResult = reportedResult(original)
        if (
          !initial ||
          initial.turns === 0 ||
          !['idle', 'error', 'cancelled'].includes(initial.status)
        ) {
          pending = true
          continue
        }
        let rows = find(`recovery:${plan.planId}:${task.id}`) ?? original
        const failed = initial.status === 'error' || initialResult?.status === 'failed'
        let recovery = events.find(
          (e): e is Recovery =>
            e.type === 'orchestration.recovery' && e.planId === plan.planId && e.taskId === task.id,
        )
        if (failed && rows === original && !recovery) {
          const project =
            parentCreated?.type === 'session.created'
              ? (parentCreated.projectPath ?? parentCreated.cwd)
              : undefined
          const agent = recoveryAgent(
            this.host.limits(project).onWorkerFailure,
            initial.instanceId,
            await this.host.providers(),
          )
          if (agent) {
            recovery = {
              type: 'orchestration.recovery',
              sessionId: parent,
              at: Date.now(),
              planId: plan.planId,
              taskId: task.id,
              workerId: initial.sessionId,
              agent,
            }
            this.host.append(recovery)
          }
        }
        if (recovery && rows === original && !this.attempted.has(`${parent}:${task.id}`)) {
          this.attempted.add(`${parent}:${task.id}`)
          try {
            await this.host.start(parent, {
              agent: recovery.agent,
              prompt: `${task.prompt}\n\nHandoff (previous attempt failed): ${(initial.lastError ?? initialResult?.summary ?? 'Failed').slice(0, 500)}\nLast reply: ${initial.lastReply.slice(-1500)}`,
              worktree: task.worktree,
              request_id: `recovery:${plan.planId}:${task.id}`,
            })
            pending = true
            continue
          } catch {
            /* Keep the original failure visible if a retry cannot be started. */
          }
        }
        const d = digest(rows)
        const result = reportedResult(rows)
        if (!d || d.turns === 0 || !['idle', 'error', 'cancelled'].includes(d.status)) {
          pending = true
          continue
        }
        const first =
          rows.find(({ event }) => event.type === 'turn.started')?.event.at ??
          rows[0]?.event.at ??
          Date.now()
        const end =
          rows.filter(({ event }) => event.type === 'turn.completed').at(-1)?.event.at ?? first
        workers.push({
          agent: d.instanceId,
          status:
            d.status === 'error' || result?.status === 'failed'
              ? 'failed'
              : d.status === 'cancelled'
                ? 'stopped'
                : (result?.status ?? 'finished'),
          result: (result?.summary ?? d.lastError ?? d.lastReply)
            .replace(/\s+/g, ' ')
            .slice(0, 500),
          files: await this.host.diff(d.cwd),
          duration: Math.max(0, end - first),
        })
      }
      if (!pending && workers.length === plan.tasks.length) {
        const text = buildSummary(plan.goal, workers)
        this.host.append({
          type: 'orchestration.summary',
          sessionId: parent,
          at: Date.now(),
          planId: plan.planId,
          text,
        })
        this.host.deliver(parent, plan.planId, text)
      }
    }
  }
}
