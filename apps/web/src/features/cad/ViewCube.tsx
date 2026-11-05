export type ViewName = 'front' | 'top' | 'right' | 'iso'

const VIEWS: { id: ViewName; label: string; short: string }[] = [
  { id: 'front', label: 'Front', short: 'Front' },
  { id: 'top', label: 'Top', short: 'Top' },
  { id: 'right', label: 'Right', short: 'Right' },
  { id: 'iso', label: 'Iso', short: 'Iso' },
]

/** Clickable standard views. Our own control, not a third-party view cube. */
export function ViewCube({ active, onView }: { active: ViewName; onView(view: ViewName): void }) {
  return (
    <div className="cad-viewcube" role="group" aria-label="Standard views">
      {VIEWS.map((view) => (
        <button
          key={view.id}
          type="button"
          aria-pressed={active === view.id}
          aria-label={view.label}
          title={view.label}
          onClick={() => onView(view.id)}
        >
          {view.short}
        </button>
      ))}
    </div>
  )
}
