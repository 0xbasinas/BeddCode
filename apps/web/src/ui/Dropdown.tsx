import { useEffect, useRef, useState, type ReactNode } from 'react'

interface DropdownProps {
  /** Renders the trigger; call `toggle` from its onClick. */
  trigger(state: { open: boolean; toggle(): void }): ReactNode
  /** Panel contents; call `close` after a choice. */
  children(close: () => void): ReactNode
  /** Open above (composer sits near the bottom) or below the trigger. */
  placement?: 'top' | 'bottom'
  align?: 'start' | 'end'
  panelClassName?: string
}

/** A small anchored popover that closes on outside click and Escape. */
export function Dropdown({
  trigger,
  children,
  placement = 'top',
  align = 'start',
  panelClassName,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="dropdown" ref={root}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className={`popover ${placement} ${align} ${panelClassName ?? ''}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
