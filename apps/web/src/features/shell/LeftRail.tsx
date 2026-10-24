import { useNavigate, useRouterState } from '@tanstack/react-router'
import { CalendarClock, Settings } from 'lucide-react'
import './leftRail.css'

/** The slim column at the left edge: one icon per screen. The sessions list keeps its own actions. */
export function LeftRail() {
  const navigate = useNavigate()
  const onSchedules = useRouterState({ select: (s) => s.location.pathname === '/schedules' })
  return (
    <nav className="left-rail" aria-label="Screens">
      <div className="left-rail-group">
        <button
          type="button"
          className={`rail-item ${onSchedules ? 'on' : ''}`}
          title="Schedules"
          aria-label="Schedules"
          aria-current={onSchedules ? 'page' : undefined}
          onClick={() => void navigate({ to: '/schedules' })}
        >
          <CalendarClock size={18} />
        </button>
      </div>
      <div className="left-rail-group">
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
