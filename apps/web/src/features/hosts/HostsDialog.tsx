import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { AddHostFlow } from './AddHostFlow.tsx'
import { HostsOverview } from './HostsOverview.tsx'
import { ShareThisComputer } from './HostAccess.tsx'
import './hosts.css'

export type HostDialogView = 'overview' | 'add' | 'share'

export function HostsDialog({
  onClose,
  initialView = 'overview',
}: {
  onClose(): void
  initialView?: HostDialogView
}) {
  const [view, setView] = useState(initialView)
  const dialog = useRef<HTMLDialogElement>(null)
  const navigate = useNavigate()
  useEffect(() => {
    const opener = document.activeElement
    const element = dialog.current!
    element.showModal()
    return () => {
      element.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])
  return createPortal(
    <dialog
      ref={dialog}
      className="hosts-dialog"
      aria-label={view === 'add' ? 'Add host' : view === 'share' ? 'Share this computer' : 'Hosts'}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
        if (event.key === 'Tab') {
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]',
            ),
          ).filter((element) => element.getClientRects().length > 0)
          const first = controls[0]
          const last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="hosts-dialog-surface">
        <header className="hosts-dialog-header">
          <span>{view === 'add' ? 'Add host' : view === 'share' ? 'This PC' : 'Hosts'}</span>
          <button className="hosts-icon-button" aria-label="Close hosts" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {view === 'add' ? (
          <AddHostFlow
            onClose={onClose}
            onStart={(hostKey) => {
              onClose()
              void navigate({ to: '/', search: { host: hostKey } })
            }}
          />
        ) : view === 'share' ? (
          <ShareThisComputer onClose={onClose} />
        ) : (
          <>
            <div className="hosts-dialog-body">
              <HostsOverview
                showPreferences={false}
                onAdd={() => setView('add')}
                onShare={() => setView('share')}
              />
            </div>
            <footer className="hosts-dialog-footer">
              <span className="hosts-escape">Esc to close</span>
              <button className="hosts-button" onClick={onClose}>
                Done
              </button>
            </footer>
          </>
        )}
      </div>
    </dialog>,
    document.body,
  )
}
