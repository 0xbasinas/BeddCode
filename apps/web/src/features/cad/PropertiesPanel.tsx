import type { CadFeature, ParamValue } from './model/CadDocument.ts'

const ORDER = [
  'width',
  'depth',
  'height',
  'radius',
  'distance',
  'angle',
  'bothSides',
  'cut',
  'targetId',
  'toolId',
  'target',
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
  return key.charAt(0).toUpperCase() + key.slice(1)
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
          <label className="cad-field">
            <span>Name</span>
            <input value={feature.name} onChange={(event) => onName(event.target.value)} />
          </label>
          <div className="cad-kind">{feature.kind}</div>
          {error ? <p className="cad-empty">{error}</p> : null}
          {orderedKeys(feature.params).map((key) => {
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
                <label key={key} className="cad-field">
                  <span>{labelOf(key)}</span>
                  <input value={value} onChange={(event) => onParam(key, event.target.value)} />
                </label>
              )
            }
            return (
              <label key={key} className="cad-field">
                <span>{labelOf(key)}</span>
                <input
                  type="number"
                  step="any"
                  value={Number.isFinite(value) ? value : 0}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    if (!Number.isFinite(next)) return
                    onParam(key, next)
                  }}
                />
              </label>
            )
          })}
        </div>
      )}
    </aside>
  )
}
