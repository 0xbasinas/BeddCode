import { useNavigate } from '@tanstack/react-router'
import { CalendarClock, PenSquare, Search, Settings } from 'lucide-react'
import { useUiStore } from '../../stores/ui.ts'
import './leftRail.css'

/** The slim column at the left edge: the app's main places, one icon each. */
export function LeftRail() {
  const navigate = useNavigate()
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  return (
    <nav className="left-rail" aria-label="Main">
      <div className="left-rail-group">
        <button
          type="button"
          className="rail-item"
          title="New session"
          aria-label="New session"
          onClick={() => void navigate({ to: '/', search: { compose: true } })}
        >
          <PenSquare size={18} />
        </button>
        <button
          type="button"
          className="rail-item"
          title="Search sessions (Ctrl+K)"
          aria-label="Search sessions"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={18} />
        </button>
      </div>
      <div className="left-rail-group">
        <button
          type="button"
          className="rail-item"
          title="Schedules"
          aria-label="Schedules"
          onClick={() => void navigate({ to: '/settings', search: { section: 'schedules' } })}
        >
          <CalendarClock size={18} />
        </button>
        <button
          type="button"
          className="rail-item"
          title="Settings"
          aria-label="Settings"
          onClick={() => void navigate({ to: '/settings' })}
        >
          <Settings size={18} />
        </button>
      </div>
    </nav>
  )
}
