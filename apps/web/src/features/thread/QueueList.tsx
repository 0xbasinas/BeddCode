import { ArrowDown, ArrowUp, Clock, CornerDownRight, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SessionView } from '@beddcode/client-runtime'
import { useState } from 'react'

type Queue = SessionView['queue']

/** Messages typed while the agent was busy. Each can be sent into the current work or dropped. */
export function QueueList({
  queue,
  busy,
  canSteer,
  editingId,
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
  /** The queued message being edited in the composer, if any. */
  editingId?: string
  onSend(queueId: string): void
  onCancel(queueId: string): void
  /** Opens the message in the composer; saving happens there. */
  onEdit?(queueId: string): void
  onMove?(queueId: string, direction: 'up' | 'down'): Promise<void>
}) {
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
      {queue.map((q, i) => {
        const editing = q.queueId === editingId
        return (
          <li
            key={q.queueId}
            className={`queue-item${editing ? ' editing' : ''}`}
            draggable={!!onMove && !pending && !editingId}
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
            {editing ? (
              <span className="queue-tag">Editing below</span>
            ) : (
              <>
                {onEdit && (
                  <Button
                    variant="app"
                    className="icon-btn small"
                    disabled={pending || !!editingId}
                    aria-label="Edit"
                    title="Edit in the message box"
                    onClick={() => onEdit(q.queueId)}
                  >
                    <Pencil size={14} />
                  </Button>
                )}
                {onMove && (
                  <>
                    <Button
                      variant="app"
                      className="icon-btn small"
                      disabled={pending || i === 0}
                      aria-label={`Move queued message ${i + 1} up`}
                      title="Move up"
                      onClick={() => void run(() => onMove(q.queueId, 'up'))}
                    >
                      <ArrowUp size={14} />
                    </Button>
                    <Button
                      variant="app"
                      className="icon-btn small"
                      disabled={pending || i === queue.length - 1}
                      aria-label={`Move queued message ${i + 1} down`}
                      title="Move down"
                      onClick={() => void run(() => onMove(q.queueId, 'down'))}
                    >
                      <ArrowDown size={14} />
                    </Button>
                  </>
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
                    <CornerDownRight size={14} />{' '}
                    {busy ? (canSteer ? 'Steer now' : 'Stop and send') : 'Send now'}
                  </button>
                )}
                <Button
                  variant="app"
                  className="icon-btn small"
                  aria-label="Remove queued message"
                  title="Remove"
                  onClick={() => onCancel(q.queueId)}
                >
                  <X size={14} />
                </Button>
              </>
            )}
          </li>
        )
      })}
      {error && (
        <li className="composer-error" role="alert">
          {error}
        </li>
      )}
    </ul>
  )
}
