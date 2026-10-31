import type { ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

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
 * choice, an outside click, Escape or resizing, and its items can be walked with the arrow keys.
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
  return (
    <DropdownMenu open modal={false} onOpenChange={(o) => !o && onClose()}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{ position: 'fixed', left: x, top: y, width: 0, height: 0, pointerEvents: 'none' }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={label}
        align="start"
        side="bottom"
        sideOffset={0}
        collisionPadding={8}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="w-auto min-w-48 max-w-80"
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            disabled={item.disabled}
            onSelect={() => item.onSelect()}
            className="items-start py-1.5"
          >
            {item.icon}
            <span className="flex flex-col">
              <span>{item.label}</span>
              {item.hint && <span className="text-xs text-muted-foreground">{item.hint}</span>}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
