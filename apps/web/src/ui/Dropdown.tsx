import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

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
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Render outside the panels, whose rounded corners clip their contents. Keep menus inside
  // the window and follow their anchor when a pane scrolls or changes size.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const place = () => {
      if (!root.current || !panel.current) return
      const anchor = root.current.getBoundingClientRect()
      const menu = panel.current.getBoundingClientRect()
      const below = anchor.bottom + 8
      const above = anchor.top - menu.height - 8
      const preferredTop =
        placement === 'top'
          ? above >= 8
            ? above
            : below
          : below + menu.height <= window.innerHeight - 8
            ? below
            : above
      const top = Math.max(8, Math.min(preferredTop, window.innerHeight - menu.height - 8))
      const left = Math.max(
        8,
        Math.min(
          align === 'end' ? anchor.right - menu.width : anchor.left,
          window.innerWidth - menu.width - 8,
        ),
      )
      setPosition((old) => (old?.top === top && old.left === left ? old : { top, left }))
    }
    place()
    const observer = new ResizeObserver(place)
    if (root.current) observer.observe(root.current)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open, placement, align])

  useEffect(() => {
    if (!open) return
    const controls = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]',
        ) ?? [],
      )
    const focusFrame = requestAnimationFrame(() => {
      if (!panel.current?.contains(document.activeElement)) controls()[0]?.focus()
    })
    const onPointer = (e: MouseEvent) => {
      if (
        root.current &&
        !root.current.contains(e.target as Node) &&
        !panel.current?.contains(e.target as Node)
      )
        setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        root.current?.querySelector<HTMLElement>('button')?.focus()
        return
      }
      if (e.key === 'Tab') {
        // The menu is portalled to the end of the document. Return to its trigger so Tab
        // continues through the composer instead of jumping to an unrelated page control.
        setOpen(false)
        root.current?.querySelector<HTMLElement>('button')?.focus()
        return
      }
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input, textarea, select, [contenteditable]')) return
      const items = controls()
      const index = items.indexOf(document.activeElement as HTMLElement)
      const direction =
        e.key === 'ArrowDown' || e.key === 'ArrowRight'
          ? 1
          : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
            ? -1
            : 0
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? items.length - 1
            : direction
              ? (index + direction + items.length) % items.length
              : undefined
      if (next !== undefined && items.length) {
        e.preventDefault()
        items[next]?.focus()
      }
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="dropdown" ref={root}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open &&
        createPortal(
          <div
            ref={panel}
            className={`popover ${panelClassName ?? ''}`}
            role="menu"
            style={{
              position: 'fixed',
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              opacity: position ? 1 : 0,
            }}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  )
}
