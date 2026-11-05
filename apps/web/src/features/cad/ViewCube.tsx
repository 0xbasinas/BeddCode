export type ViewName = 'front' | 'top' | 'right' | 'iso'

const FACES: { id: ViewName; label: string; points: string; text: string; x: number; y: number }[] =
  [
    { id: 'top', label: 'Top', points: '32,6 56,18 32,30 8,18', text: 'Top', x: 32, y: 20 },
    { id: 'front', label: 'Front', points: '8,18 32,30 32,58 8,46', text: 'Front', x: 20, y: 40 },
    { id: 'right', label: 'Right', points: '32,30 56,18 56,46 32,58', text: 'Right', x: 44, y: 40 },
  ]

/**
 * Clickable standard views for a Z-up scene.
 * Top looks down −Z, front looks along −Y, right looks along −X.
 * Our own control, not a third-party view cube.
 */
export function ViewCube({ active, onView }: { active: ViewName; onView(view: ViewName): void }) {
  return (
    <div className="cad-viewcube" role="group" aria-label="Standard views">
      <svg className="cad-viewcube-svg" viewBox="0 0 64 64" aria-hidden="true">
        {FACES.map((face) => (
          <g
            key={face.id}
            className={active === face.id ? 'is-active' : undefined}
            onClick={() => onView(face.id)}
          >
            <polygon points={face.points} />
            <text x={face.x} y={face.y}>
              {face.text}
            </text>
          </g>
        ))}
      </svg>
      <div className="cad-viewcube-list">
        {FACES.map((face) => (
          <button
            key={face.id}
            type="button"
            aria-pressed={active === face.id}
            aria-label={face.label}
            title={face.label}
            onClick={() => onView(face.id)}
          >
            {face.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={active === 'iso'}
          aria-label="Iso"
          title="Isometric"
          onClick={() => onView('iso')}
        >
          Iso
        </button>
      </div>
    </div>
  )
}
