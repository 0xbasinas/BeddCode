import { useState, type ReactNode } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

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

/**
 * A small anchored popover (shadcn Popover) that closes on outside click and Escape, stays inside
 * the window, and flips to the other side when there is no room.
 */
export function Dropdown({
  trigger,
  children,
  placement = 'top',
  align = 'start',
  panelClassName,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="dropdown">{trigger({ open, toggle: () => setOpen((o) => !o) })}</div>
      </PopoverAnchor>
      <PopoverContent
        side={placement}
        align={align}
        sideOffset={8}
        collisionPadding={8}
        role="menu"
        className={cn(
          'popover-panel max-h-(--radix-popover-content-available-height) w-70 gap-0 overflow-y-auto p-1.5',
          panelClassName === 'wide' && 'w-85',
          panelClassName,
        )}
      >
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  )
}
