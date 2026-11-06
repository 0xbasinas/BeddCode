import { X } from 'lucide-react'
import type { Annotation } from './annotations.ts'

/**
 * Pinned measurement cards in the corner of the viewport.
 *
 * Each card survives until it is dismissed or its feature is deleted, so a part
 * with several measured features can be read at once instead of one value at a time.
 */
export function AnnotationCards({
  items,
  onDismiss,
}: {
  items: readonly Annotation[]
  onDismiss(id: string): void
}) {
  if (items.length === 0) return null
  return (
    <div className="cad-annotations" role="list" aria-label="Measurements">
      {items.map((item) => (
        <div key={item.id} className="cad-annotation" role="listitem">
          <div className="cad-annotation-head">
            <span className="cad-annotation-title">{item.title}</span>
            <button
              type="button"
              className="cad-annotation-close"
              aria-label={`Dismiss ${item.title}`}
              title="Dismiss"
              onClick={() => onDismiss(item.id)}
            >
              <X size={11} />
            </button>
          </div>
          {item.lines.map((line) => (
            <p key={line} className="cad-annotation-line">
              {line}
            </p>
          ))}
        </div>
      ))}
    </div>
  )
}
