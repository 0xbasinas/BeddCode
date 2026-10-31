import { Clock, CornerDownRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SessionView } from '@beddcode/client-runtime'

type Queue = SessionView['queue']

/** Messages typed while the agent was busy. Each can be sent into the current work or dropped. */
export function QueueList({
  queue,
  busy,
  canSteer,
  onSend,
  onCancel,
}: {
  queue: Queue
  /** The agent is working: a queued message can jump ahead. Otherwise it is only waiting to go out. */
  busy: boolean
  /** The agent takes messages mid-turn; without that, "send now" stops the current turn first. */
  canSteer: boolean
  onSend(queueId: string): void
  onCancel(queueId: string): void
}) {
  if (queue.length === 0) return null
  return (
    <ul className="queue-list" aria-label="Queued messages">
      {queue.map((q, i) => (
        <li key={q.queueId} className="queue-item">
          <Clock size={14} />
          <span className="queue-text" title={q.text}>
            {q.text || q.attachments.map((a) => a.name).join(', ')}
          </span>
          {i === 0 && (
            <button
              className="queue-send"
              onClick={() => onSend(q.queueId)}
              title={
                busy && !canSteer
                  ? 'Stops the current turn and sends this now'
                  : busy
                    ? 'Adds this to what the agent is doing now'
                    : 'Send this now'
              }
            >
              <CornerDownRight size={13} />{' '}
              {busy ? (canSteer ? 'Steer now' : 'Stop and send') : 'Send now'}
            </button>
          )}
          <Button
            variant="app"
            className="icon-btn small"
            aria-label="Remove queued message"
            onClick={() => onCancel(q.queueId)}
          >
            <X size={14} />
          </Button>
        </li>
      ))}
    </ul>
  )
}
