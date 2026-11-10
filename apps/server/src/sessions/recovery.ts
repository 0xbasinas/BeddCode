import type { StoredEvent } from '@beddcode/contracts'
import type { EventStore } from '../store/eventStore.ts'

const pendingResume = new Map<
  string,
  { turnId?: string; prompt?: { text: string; attachments: { name: string; path: string }[] } }
>()

function track(active: Map<string, { turnId?: string; at: number }>, { event }: StoredEvent) {
  if (
    event.type === 'turn.started' ||
    event.type === 'tool.started' ||
    event.type === 'approval.requested'
  ) {
    active.set(event.sessionId, { turnId: event.turnId, at: event.at })
  } else if (event.type === 'turn.completed' || event.type === 'error') {
    active.delete(event.sessionId)
  }
}

export type AutoResume = 'off' | 'ask' | 'auto'
/** A turn that keeps dying with the host (a crash loop) stops resuming and asks the user. */
export const MAX_AUTO_RESUMES = 3

export function autoResumeFromEnv(env: NodeJS.ProcessEnv = process.env): AutoResume {
  const v = env.BEDDCODE_AUTO_RESUME
  return v === 'off' || v === 'ask' || v === 'auto' ? v : 'auto'
}

const AUTO_RESUME_KEY = 'host-auto-resume:'

const CONTINUATION_PREFIX = 'The host restarted while you were working'

function clearAttempts(attempts: Map<string, number>, sessionId: string) {
  for (const k of [...attempts.keys()]) if (k.startsWith(`${sessionId}:`)) attempts.delete(k)
}

function continuationPrompt(original: string) {
  return {
    text: `${CONTINUATION_PREFIX} (most likely after a change to the server or desktop code). Continue where you left off. Check the working tree and verify the current state instead of assuming the last step finished.\n\nOriginal request: ${original.slice(0, 4000)}`,
    attachments: [] as { name: string; path: string }[],
  }
}

/** Provider processes are gone after a host restart. Replaying their last status must not
 * leave the client waiting forever. History and provider resume IDs remain intact.
 * A turn cut off without a graceful-shutdown marker (a file-watch reload, a kill, a crash) is
 * resumed on its own when `autoResume` is "auto", up to MAX_AUTO_RESUMES times per turn. */
export function recoverInterruptedTurns(
  store: EventStore,
  autoResume: AutoResume = 'auto',
  /** Sessions whose agent is still running under the supervisor: they are reattached, not cancelled. */
  held: ReadonlySet<string> = new Set(),
): string[] {
  pendingResume.clear()
  const providerIds = new Set<string>()
  const lastUser = new Map<string, string>()
  const attempts = new Map<string, number>()
  const active = new Map<string, { turnId?: string; at: number }>()
  const updating = new Map<string, Extract<StoredEvent['event'], { type: 'host.updating' }>>()
  const createdAt = new Map<string, number>()
  const interrupted = new Set<string>()
  let cursor = 0
  for (;;) {
    const events = store.readAfter(cursor, 5000)
    if (!events.length) break
    for (const stored of events) {
      const event = stored.event
      track(active, stored)
      if (event.type === 'session.created') createdAt.set(event.sessionId, event.at)
      if (event.type === 'host.updating') updating.set(event.sessionId, event)
      if (event.type === 'session.provider-session') providerIds.add(event.sessionId)
      // Turn ids like "turn-1" repeat across turns, so attempts only count the run of restarts
      // since the user last spoke or a turn last finished. Our own continuation prompts are not
      // the user speaking: they are what the loop guard counts.
      if (
        event.type === 'message.delta' &&
        event.role === 'user' &&
        !event.text.startsWith(CONTINUATION_PREFIX)
      ) {
        lastUser.set(event.sessionId, event.text)
        clearAttempts(attempts, event.sessionId)
      }
      if (event.type === 'turn.completed' && event.reason !== 'cancelled')
        clearAttempts(attempts, event.sessionId)
      if (event.type === 'session.notice' && event.key?.startsWith(AUTO_RESUME_KEY)) {
        const turn = event.key.slice(AUTO_RESUME_KEY.length).split(':')[0] ?? ''
        const k = `${event.sessionId}:${turn}`
        attempts.set(k, (attempts.get(k) ?? 0) + 1)
      }
      if (event.type === 'turn.interrupted') interrupted.add(event.sessionId)
      if (event.type === 'turn.interruption-resolved') interrupted.delete(event.sessionId)
      if (event.type === 'turn.completed' || event.type === 'error')
        updating.delete(event.sessionId)
    }
    cursor = events.at(-1)!.seq
  }
  const resume: string[] = []
  for (const [sessionId, { turnId, at }] of active) {
    const marker = updating.get(sessionId)
    const marked = marker !== undefined && at >= (createdAt.get(sessionId) ?? 0)
    if (marked && marker) {
      resume.push(sessionId)
      // The marker is the durable resume record. SessionManager handles provider setup.
      pendingResume.set(sessionId, { turnId, prompt: marker.prompt })
      updating.delete(sessionId)
      continue
    }
    if (held.has(sessionId)) {
      // The host died but the agent did not: its turn carries on and the output it wrote meanwhile
      // is replayed when the session is reattached (there is no prompt to send again).
      resume.push(sessionId)
      pendingResume.set(sessionId, { turnId })
      continue
    }
    const original = lastUser.get(sessionId)
    const tried = attempts.get(`${sessionId}:${turnId ?? ''}`) ?? 0
    if (
      autoResume === 'auto' &&
      !interrupted.has(sessionId) &&
      providerIds.has(sessionId) &&
      original !== undefined &&
      tried < MAX_AUTO_RESUMES
    ) {
      // Timeline marker; it also counts attempts, so the next crash sees how many were made.
      store.append({
        type: 'session.notice',
        sessionId,
        at: Date.now(),
        key: `${AUTO_RESUME_KEY}${turnId ?? ''}:${tried + 1}`,
        message: `Host restarted, resumed automatically${tried ? ` (attempt ${tried + 1} of ${MAX_AUTO_RESUMES})` : ''}.`,
      })
      resume.push(sessionId)
      pendingResume.set(sessionId, { turnId, prompt: continuationPrompt(original) })
      continue
    }
    const gaveUp = autoResume === 'auto' && tried >= MAX_AUTO_RESUMES
    if (!interrupted.has(sessionId)) {
      store.append({
        type: 'turn.interrupted',
        sessionId,
        turnId,
        at: Date.now(),
        message: gaveUp
          ? `The host restarted ${tried} times during this turn, so it was not resumed again.`
          : 'The host restarted before this turn finished.',
      })
    }
    store.append({
      type: 'turn.completed',
      sessionId,
      turnId,
      at: Date.now(),
      reason: 'cancelled',
      message: marked
        ? 'The host restarted, but this agent could not resume the interrupted turn. Send a message to continue this session.'
        : 'The host restarted before this turn finished. Send a message to continue this session.',
    })
  }
  return resume
}

export function takeInterruptedSessions() {
  const sessions = [...pendingResume].map(([sessionId, saved]) => ({ sessionId, ...saved }))
  pendingResume.clear()
  return sessions
}
