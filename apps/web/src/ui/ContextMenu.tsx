import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  id: string
  label: string
  /** A line under the label, such as why the item is not available. */
  hint?: string
  icon?: ReactNode
  disabled?: boolean
  onSelect(): void
}

/**
 * A menu opened where the pointer was (a right click), kept inside the window. It closes on a
 * choice, an outside click, Escape, scrolling or the window losing focus, and its items can be
 * walked with the arrow keys.
 */
export function ContextMenu({
  x,
  y,
  items,
  label,
  onClose,
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  label: string
  onClose(): void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number }>()

  useLayoutEffect(() => {
    const menu = panel.current?.getBoundingClientRect()
    if (!menu) return
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - menu.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - menu.height - 8)),
    })
  }, [x, y])

  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const away = (e: Event) => {
      if (e.target instanceof Node && panel.current?.contains(e.target)) return
      onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const buttons = [
        ...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
      ]
      if (buttons.length === 0) return
      e.preventDefault()
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = e.key === 'ArrowDown' ? at + 1 : at - 1
      buttons[(next + buttons.length) % buttons.length]?.focus()
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('contextmenu', away, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    document.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('contextmenu', away, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={panel}
      className="popover context-menu"
      role="menu"
      aria-label={label}
      style={{
        position: 'fixed',
        left: position?.left ?? x,
        top: position?.top ?? y,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          role="menuitem"
          className="menu-row"
          disabled={item.disabled}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.icon}
          <span className="menu-text">
            <span className="menu-title">{item.label}</span>
            {item.hint && <span className="menu-desc">{item.hint}</span>}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
