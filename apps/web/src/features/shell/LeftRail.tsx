import { useNavigate, useRouterState } from '@tanstack/react-router'
import { CalendarClock, House, Settings } from 'lucide-react'
import './leftRail.css'

/** The slim column at the left edge: one icon per screen. The sessions list keeps its own actions. */
export function LeftRail() {
  const navigate = useNavigate()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const onHome = path === '/'
  const onSchedules = path === '/schedules'
  return (
    <nav className="left-rail" aria-label="Screens">
      <div className="left-rail-group">
        <button
          type="button"
          className={`rail-item ${onHome ? 'on' : ''}`}
          title="Home"
          aria-label="Home"
          aria-current={onHome ? 'page' : undefined}
          onClick={() => void navigate({ to: '/' })}
        >
          <House size={18} />
        </button>
      </div>
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
