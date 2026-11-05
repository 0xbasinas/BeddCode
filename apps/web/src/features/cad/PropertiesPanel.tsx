import { useState, type KeyboardEvent } from 'react'
import type { CadFeature, ParamValue } from './model/CadDocument.ts'
import { SpinInput } from './SpinInput.tsx'

const ORDER = [
  'width',
  'depth',
  'height',
  'diameter',
  'radius',
  'distance',
  'angle',
  'throughAll',
  'bothSides',
  'cut',
  'cboreDiameter',
  'cboreDepth',
  'targetId',
  'target',
  'toolId',
  'tool',
  'edgeIds',
  'axis',
  'plane',
  'fileName',
  'sketchId',
  'x',
  'y',
  'z',
]

/** Signature blob. The tree and the kernel read it; the form does not edit it. */
const HIDDEN = new Set(['edgeRefs'])

const LABELS: Record<string, string> = {
  throughAll: 'Through all',
  bothSides: 'Both sides',
  targetId: 'Target',
  target: 'Target',
  toolId: 'Tool',
  tool: 'Tool',
  edgeIds: 'Edges',
  cboreDiameter: 'Counterbore diameter',
  cboreDepth: 'Counterbore depth',
  sketchId: 'Sketch',
  fileName: 'File',
  diameter: 'Diameter',
  depth: 'Depth',
}

function orderedKeys(params: CadFeature['params']): string[] {
  return Object.keys(params).sort((a, b) => {
    const ia = ORDER.indexOf(a)
    const ib = ORDER.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
}

function labelOf(key: string): string {
  return LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}

/** Text property. The draft stays local until Enter or blur. Escape restores the model text. */
function TextParam({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit(next: string): void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    if (draft === null) return
    const next = draft
    setDraft(null)
    if (next !== value) onCommit(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDraft(null)
    }
  }

  return (
    <label className="cad-field">
      <span>{label}</span>
      <input
        value={draft ?? value}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </label>
  )
}

export function PropertiesPanel({
  feature,
  error,
  onName,
  onParam,
}: {
  feature: CadFeature | null
  error?: string
  onName(name: string): void
  onParam(key: string, value: ParamValue): void
}) {
  return (
    <aside className="cad-props" aria-label="Properties">
      <div className="cad-side-title">Properties</div>
      {!feature ? (
        <p className="cad-empty">Select a feature to edit its parameters.</p>
      ) : (
        <div className="cad-prop-body">
          <TextParam key={feature.id} label="Name" value={feature.name} onCommit={onName} />
          <div className="cad-kind">{feature.kind}</div>
          {error ? <p className="cad-empty">{error}</p> : null}
          {orderedKeys(feature.params).map((key) => {
            if (HIDDEN.has(key)) return null
            const value = feature.params[key]
            if (typeof value === 'boolean') {
              return (
                <label key={key} className="cad-check">
                  <input
                    type="checkbox"
                    checked={value}
                    onChange={(event) => onParam(key, event.target.checked)}
                  />
                  <span>{labelOf(key)}</span>
                </label>
              )
            }
            if (typeof value === 'string') {
              return (
                <TextParam
                  key={`${feature.id}:${key}`}
                  label={labelOf(key)}
                  value={value}
                  onCommit={(next) => onParam(key, next)}
                />
              )
            }
            if (typeof value !== 'number') return null
            return (
              <SpinInput
                key={`${feature.id}:${key}`}
                label={labelOf(key)}
                value={value}
                onCommit={(next) => onParam(key, next)}
              />
            )
          })}
        </div>
      )}
    </aside>
  )
}
