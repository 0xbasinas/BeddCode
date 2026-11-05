import { ChevronDown, ChevronUp, Eye, EyeOff, Trash2 } from 'lucide-react'
import type { CadFeature } from './model/CadDocument.ts'

export function FeatureTree({
  features,
  historyIndex,
  selectedId,
  onSelect,
  onSuppress,
  onDelete,
  onReorder,
}: {
  features: CadFeature[]
  historyIndex: number
  selectedId: string | null
  onSelect(id: string): void
  onSuppress(id: string): void
  onDelete(id: string): void
  onReorder(id: string, direction: -1 | 1): void
}) {
  return (
    <aside className="cad-tree" aria-label="Feature tree">
      <div className="cad-side-title">Features</div>
      {features.length === 0 ? (
        <p className="cad-empty">No features yet. Use New box to add one.</p>
      ) : (
        <ul className="cad-feature-list">
          {features.map((feature, index) => {
            const rolled = index > historyIndex
            return (
              <li
                key={feature.id}
                className={`cad-feature${feature.suppressed ? ' suppressed' : ''}${rolled ? ' rolled' : ''}`}
                aria-selected={selectedId === feature.id}
              >
                <button
                  type="button"
                  className="cad-feature-name"
                  onClick={() => onSelect(feature.id)}
                >
                  <span>{feature.name}</span>
                  <span className="cad-feature-kind">{feature.kind}</span>
                </button>
                <button
                  type="button"
                  className="cad-icon"
                  aria-label={
                    feature.suppressed ? `Show ${feature.name}` : `Suppress ${feature.name}`
                  }
                  title={feature.suppressed ? 'Show' : 'Suppress'}
                  onClick={() => onSuppress(feature.id)}
                >
                  {feature.suppressed ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  className="cad-icon"
                  aria-label={`Move ${feature.name} up`}
                  title="Move up"
                  disabled={index === 0}
                  onClick={() => onReorder(feature.id, -1)}
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  type="button"
                  className="cad-icon"
                  aria-label={`Move ${feature.name} down`}
                  title="Move down"
                  disabled={index === features.length - 1}
                  onClick={() => onReorder(feature.id, 1)}
                >
                  <ChevronDown size={13} />
                </button>
                <button
                  type="button"
                  className="cad-icon"
                  aria-label={`Delete ${feature.name}`}
                  title="Delete"
                  onClick={() => onDelete(feature.id)}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
