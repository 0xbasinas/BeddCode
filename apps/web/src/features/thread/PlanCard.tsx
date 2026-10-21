import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp, Circle, CircleDot, ListChecks } from 'lucide-react'
import type { SessionView } from '@beddcode/client-runtime'

type Plan = NonNullable<SessionView['plan']>

const ICONS = {
  completed: CheckCircle2,
  'in-progress': CircleDot,
  pending: Circle,
} as const

/** The agent's own to-do list, kept above the composer while the work is under way. */
export function PlanCard({ plan }: { plan: Plan }) {
  const done = plan.steps.filter((s) => s.status === 'completed').length
  const finished = done === plan.steps.length
  // Open while there is work left; a finished plan folds away but stays one click from view.
  const [open, setOpen] = useState<boolean | undefined>(undefined)
  const shown = open ?? !finished
  if (plan.steps.length === 0) return null

  return (
    <div className="plan-card">
      <button
        className="plan-head"
        onClick={() => setOpen(!shown)}
        aria-expanded={shown}
        aria-label="Plan"
      >
        <ListChecks size={15} />
        <span>
          Plan{' '}
          <span className="muted">
            · {done} of {plan.steps.length} done
          </span>
        </span>
        {shown ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {shown && (
        <ol className="plan-steps">
          {plan.explanation && <li className="plan-note muted">{plan.explanation}</li>}
          {plan.steps.map((step, i) => {
            const Icon = ICONS[step.status]
            return (
              <li key={i} className={`plan-step ${step.status}`}>
                <Icon size={14} />
                <span>{step.text}</span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
