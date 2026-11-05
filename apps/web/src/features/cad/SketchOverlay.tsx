/** A length, radius, or distance pinned over the WebGL canvas. */
export interface OverlayLabel {
  id: string
  text: string
  /** CSS pixels inside the viewport. */
  x: number
  y: number
  kind?: 'sketch' | 'measure'
}

/**
 * Muted dimension text for sketch entities and the measure line.
 * The lines themselves are drawn in the WebGL scene.
 */
export function SketchOverlay({ labels }: { labels: OverlayLabel[] }) {
  if (labels.length === 0) return null
  return (
    <div className="cad-sketch-overlay">
      {labels.map((label) => (
        <span
          key={label.id}
          className={label.kind === 'measure' ? 'cad-measure-label' : 'cad-sketch-label'}
          style={{ left: label.x, top: label.y }}
        >
          {label.text}
        </span>
      ))}
    </div>
  )
}
