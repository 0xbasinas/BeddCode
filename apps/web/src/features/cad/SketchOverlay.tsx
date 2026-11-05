import type { KeyboardEvent, RefObject } from 'react'

/** A length, radius, or distance pinned over the WebGL canvas. */
export interface OverlayLabel {
  id: string
  text: string
  /** CSS pixels inside the viewport. */
  x: number
  y: number
  kind?: 'sketch' | 'measure' | 'snap'
}

/** Editable size shown after the first point of a line, rectangle, or circle. */
export interface DimensionDraft {
  x: number
  y: number
  text: string
  placeholder: string
  label: string
}

/**
 * Muted dimension text for sketch entities and the measure line.
 * Sketch labels can be edited. The lines themselves are drawn in the WebGL scene.
 */
export function SketchOverlay({
  labels,
  draft,
  editId,
  editText,
  draftRef,
  editRef,
  onDraftText,
  onDraftKeyDown,
  onEdit,
  onEditText,
  onEditKeyDown,
}: {
  labels: OverlayLabel[]
  draft?: DimensionDraft | null
  editId?: string | null
  editText?: string
  draftRef?: RefObject<HTMLInputElement | null>
  editRef?: RefObject<HTMLInputElement | null>
  onDraftText?: (text: string) => void
  onDraftKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  onEdit?: (label: OverlayLabel) => void
  onEditText?: (text: string) => void
  onEditKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
}) {
  if (labels.length === 0 && !draft) return null
  return (
    <div className="cad-sketch-overlay">
      {labels.map((label) => {
        if (label.kind === 'snap') {
          return (
            <span
              key={label.id}
              className="cad-snap-marker"
              style={{ left: label.x, top: label.y }}
            >
              <span>{label.text}</span>
            </span>
          )
        }
        if (label.kind === 'sketch' && label.id !== 'preview' && editId === label.id) {
          return (
            <input
              key={label.id}
              ref={editRef}
              className="cad-dimension-input"
              style={{ left: label.x, top: label.y }}
              value={editText ?? ''}
              aria-label="Dimension"
              onChange={(event) => onEditText?.(event.target.value)}
              onKeyDown={onEditKeyDown}
              onPointerDown={(event) => event.stopPropagation()}
            />
          )
        }
        if (label.kind === 'sketch' && label.id !== 'preview') {
          return (
            <button
              key={label.id}
              type="button"
              className="cad-sketch-label"
              style={{ left: label.x, top: label.y }}
              onClick={() => onEdit?.(label)}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {label.text}
            </button>
          )
        }
        return (
          <span
            key={label.id}
            className={label.kind === 'measure' ? 'cad-measure-label' : 'cad-sketch-label'}
            style={{ left: label.x, top: label.y }}
          >
            {label.text}
          </span>
        )
      })}
      {draft ? (
        <input
          ref={draftRef}
          className="cad-dimension-input"
          style={{ left: draft.x, top: draft.y }}
          value={draft.text}
          placeholder={draft.placeholder}
          aria-label={draft.label}
          onChange={(event) => onDraftText?.(event.target.value)}
          onKeyDown={onDraftKeyDown}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : null}
    </div>
  )
}
