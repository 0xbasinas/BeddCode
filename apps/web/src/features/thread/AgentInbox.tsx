import './agentInbox.css'
import { useState } from 'react'
import { inboxThreads, type SessionView } from '@beddcode/client-runtime'
import { useHostStore } from '../../stores/host.ts'

const empty: Record<string, SessionView> = {}

export function AgentInbox({ session, hostKey }: { session: SessionView; hostKey: string }) {
  const sessions = useHostStore((s) => s.runtimes[hostKey]?.replica.sessions ?? empty)
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState(false)
  const members = group
    ? Object.values(sessions).filter((s) => s.projectPath === session.projectPath && !s.projectless)
    : [session]
  const threads = inboxThreads(members)
  const name = (id: string) => sessions[id]?.title || id
  return (
    <section className="orchestration-panel">
      <button
        type="button"
        className="orch-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="orch-title">
          Agent inbox · {threads.length} {threads.length === 1 ? 'thread' : 'threads'}
        </span>
        <span className="orch-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {open && (
        <div className="orchestration-content">
          <div className="orchestration-actions">
            <button type="button" aria-pressed={!group} onClick={() => setGroup(false)}>
              This session
            </button>
            {!session.projectless && (
              <button type="button" aria-pressed={group} onClick={() => setGroup(true)}>
                Project group
              </button>
            )}
          </div>
          {threads.length === 0 && <p>No agent messages yet.</p>}
          {threads.map((thread) => (
            <div className="orchestration-row" key={thread.threadId}>
              <strong>Thread {thread.threadId}</strong>
              {thread.messages.map((message) => (
                <div key={message.messageId ?? message.id}>
                  <small>
                    {name(message.senderId)} → {name(message.recipientId)}
                  </small>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
