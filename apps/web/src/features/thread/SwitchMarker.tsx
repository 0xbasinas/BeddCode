import { agentLabel, parseHandoffNote } from '@beddcode/client-runtime'
import type { ProviderInstance } from '@beddcode/contracts'

/** The note that was sent on a switch, one labelled block per section. */
export function HandoffNote({ note }: { note: string }) {
  return (
    <div className="handoff-note">
      {parseHandoffNote(note).map((part, i) => (
        <section key={i}>
          {part.title && <h4>{part.title}</h4>}
          <p>{part.body}</p>
        </section>
      ))}
    </div>
  )
}

/** A line across the thread where the session moved to another agent; the note opens on click. */
export function SwitchMarkerView({
  item,
  providers,
}: {
  item: {
    from: string
    to: string
    handoff: string
    permissionLabel?: string
    permissionNote?: string
  }
  providers?: ProviderInstance[]
}) {
  return (
    <details className="turn-notice handoff-marker">
      <summary>
        Switched from {agentLabel(providers, item.from)} to {agentLabel(providers, item.to)}
      </summary>
      {item.permissionNote ? (
        <p className="handoff-permissions">{item.permissionNote}</p>
      ) : item.permissionLabel ? (
        <p className="handoff-permissions">Permissions: {item.permissionLabel}</p>
      ) : null}
      <HandoffNote note={item.handoff} />
    </details>
  )
}
