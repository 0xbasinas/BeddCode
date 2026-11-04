import type { SessionView, TranscriptItem } from './replica.ts'

type AgentMessage = Extract<TranscriptItem, { kind: 'agent-message' }>

/** Group delivered messages into threads. Each delivery is stored in both participants' sessions. */
export function inboxThreads(
  sessions: SessionView[],
): { threadId: string; messages: AgentMessage[] }[] {
  const threads = new Map<string, AgentMessage[]>()
  const seen = new Set<string>()
  const ids = new Set(sessions.map((session) => session.id))
  for (const session of sessions) {
    for (const item of session.items) {
      if (item.kind !== 'agent-message') continue
      // Older cached replicas predate messageId. Prefer the sender's copy when both are present.
      if (!item.messageId && session.id !== item.senderId && ids.has(item.senderId)) continue
      if (item.messageId && seen.has(item.messageId)) continue
      if (item.messageId) seen.add(item.messageId)
      const messages = threads.get(item.threadId) ?? []
      messages.push(item)
      threads.set(item.threadId, messages)
    }
  }
  return [...threads].map(([threadId, messages]) => ({
    threadId,
    messages: messages.sort((a, b) => Number(a.id) - Number(b.id)),
  }))
}
