import { Clock, CornerDownRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SessionView } from '@beddcode/client-runtime'
import { useState } from 'react'

type Queue = SessionView['queue']

/** Messages typed while the agent was busy. Each can be sent into the current work or dropped. */
export function QueueList({
  queue,
  busy,
  canSteer,
  onSend,
  onCancel,
  onEdit,
  onMove,
}: {
  queue: Queue
  /** The agent is working: a queued message can jump ahead. Otherwise it is only waiting to go out. */
  busy: boolean
  /** The agent takes messages mid-turn; without that, "send now" stops the current turn first. */
  canSteer: boolean
  onSend(queueId: string): void
  onCancel(queueId: string): void
  onEdit?(queueId: string, text: string, expectedText: string): Promise<void>
  onMove?(queueId: string, direction: 'up' | 'down'): Promise<void>
}) {
  const [editing, setEditing] = useState<{ id: string; text: string; original: string }>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (action: () => Promise<void>) => {
    setPending(true)
    setError(undefined)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }
  if (queue.length === 0) return null
  return (
    <ul className="queue-list" aria-label="Queued messages">
      {queue.map((q, i) => (
        <li
          key={q.queueId}
          className="queue-item"
          draggable={!!onMove && !pending && !editing}
          onDragStart={(event) => event.dataTransfer.setData('text/beddcode-queue', q.queueId)}
          onDragOver={(event) => {
            if (onMove) event.preventDefault()
          }}
          onDrop={(event) => {
            event.preventDefault()
            const id = event.dataTransfer.getData('text/beddcode-queue')
            const from = queue.findIndex((item) => item.queueId === id)
            if (!onMove || from < 0 || from === i) return
            void run(async () => {
              for (let n = 0; n < Math.abs(i - from); n++)
                await onMove(id, i > from ? 'down' : 'up')
            })
          }}
        >
          <Clock size={14} />
          <span className="queue-text" title={q.text}>
            {q.text || q.attachments.map((a) => a.name).join(', ')}
          </span>
          {onEdit && (
            <button
              disabled={pending}
              onClick={() => setEditing({ id: q.queueId, text: q.text, original: q.text })}
            >
              Edit
            </button>
          )}
          {onMove && (
            <>
              <button
                disabled={pending || i === 0}
                aria-label={`Move queued message ${i + 1} up`}
                onClick={() => void run(() => onMove(q.queueId, 'up'))}
              >
                ↑
              </button>
              <button
                disabled={pending || i === queue.length - 1}
                aria-label={`Move queued message ${i + 1} down`}
                onClick={() => void run(() => onMove(q.queueId, 'down'))}
              >
                ↓
              </button>
            </>
          )}
          {editing?.id === q.queueId && (
            <div>
              <textarea
                aria-label="Edit queued message"
                value={editing.text}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              />
              <button
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await onEdit!(q.queueId, editing.text, editing.original)
                    setEditing(undefined)
                  })
                }
              >
                Save queued message
              </button>
              <button disabled={pending} onClick={() => setEditing(undefined)}>
                Cancel edit
              </button>
            </div>
          )}
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
      {error && (
        <li className="composer-error" role="alert">
          {error}
        </li>
      )}
    </ul>
  )
}
