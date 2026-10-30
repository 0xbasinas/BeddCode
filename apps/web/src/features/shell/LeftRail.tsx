import { useNavigate, useRouterState } from '@tanstack/react-router'
import { CalendarClock, House, PenTool, Settings } from 'lucide-react'
import './leftRail.css'

/** A Linear-style mark (a ring with diagonal bands); lucide has no brand icons. */
function LinearIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9.5" />
      <path d="M3.5 15.5 8.5 20.5M3 11l10 10M7 5l12 12M11 3l10 10M15.5 3.5l5 5" strokeWidth="1.6" />
    </svg>
  )
}

/** The slim column at the left edge: one icon per screen. The sessions list keeps its own actions. */
export function LeftRail() {
  const navigate = useNavigate()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const onHome = path === '/'
  const onSchedules = path === '/schedules'
  const onDesign = path === '/design'
  const onLinear = path === '/linear'
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
        <button
          type="button"
          className={`rail-item ${onDesign ? 'on' : ''}`}
          title="Design"
          aria-label="Design"
          aria-current={onDesign ? 'page' : undefined}
          onClick={() => void navigate({ to: '/design' })}
        >
          <PenTool size={18} />
        </button>
      </div>
      <div className="left-rail-group">
        <button
          type="button"
          className={`rail-item ${onLinear ? 'on' : ''}`}
          title="Linear"
          aria-label="Linear"
          aria-current={onLinear ? 'page' : undefined}
          onClick={() => void navigate({ to: '/linear' })}
        >
          <LinearIcon size={18} />
        </button>
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
