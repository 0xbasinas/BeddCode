import type { SessionEvent, StoredEvent } from '@beddcode/contracts'

export type DigestStatus = 'starting' | 'running' | 'needs-you' | 'idle' | 'error' | 'cancelled'

/** A session in a few facts, read straight from its log. */
export interface SessionDigest {
  sessionId: string
  title: string
  instanceId: string
  cwd: string
  branch?: string
  status: DigestStatus
  /** The agent's words since the last message it was sent. */
  lastReply: string
  /** What it is waiting on, when it waits for the user. */
  waitingOn?: string
  turns: number
  lastError?: string
  parentSessionId?: string
  depth: number
}

type Created = Extract<SessionEvent, { type: 'session.created' }>

export function digest(events: StoredEvent[]): SessionDigest | undefined {
  let created: Created | undefined
  let title = ''
  let status: DigestStatus = 'starting'
  let reply: string[] = []
  let turns = 0
  let lastError: string | undefined
  const open = new Map<string, string>()
  // Something between two replies (a tool call, say) makes them separate messages.
  let split = false
  for (const { event } of events) {
    if (event.type !== 'message.delta') split = reply.length > 0
    switch (event.type) {
      case 'session.created':
        created = event
        title = event.title
        status = 'idle'
        break
      case 'session.renamed':
        title = event.title
        break
      case 'turn.started':
        status = 'running'
        break
      case 'turn.completed':
        turns++
        status = event.reason === 'done' ? 'idle' : event.reason
        if (event.reason === 'error' && event.message) lastError = event.message
        open.clear()
        break
      case 'message.delta':
        if (event.role === 'user') reply = []
        else {
          if (split) reply.push('\n\n')
          reply.push(event.text)
        }
        split = false
        break
      case 'approval.requested':
        open.set(event.requestId, event.title)
        break
      case 'question.requested':
        open.set(event.requestId, event.questions[0]?.question ?? 'A question')
        break
      case 'approval.resolved':
      case 'question.resolved':
        open.delete(event.requestId)
        break
      case 'error':
        lastError = event.message
        break
    }
  }
  if (!created) return undefined
  const waiting = [...open.values()].at(-1)
  return {
    sessionId: created.sessionId,
    title,
    instanceId: created.instanceId,
    cwd: created.cwd,
    branch: created.branch,
    status: waiting && status === 'running' ? 'needs-you' : status,
    lastReply: reply.join('').trim(),
    waitingOn: waiting,
    turns,
    lastError,
    parentSessionId: created.parent?.sessionId,
    depth: created.parent?.depth ?? 0,
  }
}

/** The conversation as plain text, newest kept when it is too long. */
export function transcript(events: StoredEvent[], maxChars = 8_000): string {
  const lines: string[] = []
  let role: 'user' | 'assistant' | undefined
  for (const { event } of events) {
    if (event.type === 'message.delta') {
      if (event.role !== role) {
        lines.push(`\n${event.role === 'user' ? 'User' : 'Agent'}: `)
        role = event.role
      }
      lines.push(event.text)
    } else if (event.type === 'tool.started') {
      lines.push(`\n[tool] ${event.title}`)
      role = undefined
    } else if (event.type === 'turn.completed' && event.reason !== 'done') {
      lines.push(`\n[turn ${event.reason}${event.message ? `: ${event.message}` : ''}]`)
      role = undefined
    }
  }
  const text = lines.join('').trim()
  return text.length > maxChars ? `…${text.slice(text.length - maxChars)}` : text
}
