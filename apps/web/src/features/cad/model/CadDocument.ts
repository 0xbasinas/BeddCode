/** A CAD part stored as JSON. Edits return a new document and bump `rev`. */

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in'

export type FeatureKind =
  | 'box'
  | 'cylinder'
  | 'sphere'
  | 'extrude'
  | 'revolve'
  | 'fillet'
  | 'chamfer'
  | 'union'
  | 'cut'
  | 'intersect'
  | 'sketch'

export type ParamValue = number | string | boolean

export interface SketchEntity {
  id: string
  kind: 'line' | 'circle' | 'arc' | 'point'
  params: Record<string, number>
}

export interface CadSketch {
  id: string
  name: string
  plane: 'XY' | 'YZ' | 'ZX'
  entities: SketchEntity[]
}

export interface CadFeature {
  id: string
  name: string
  kind: FeatureKind
  /** Numbers the properties panel edits, plus the occasional label or flag. */
  params: Record<string, ParamValue>
  suppressed: boolean
  sketchId?: string
}

export interface CadDocument {
  id: string
  name: string
  units: LengthUnit
  /** Bumps on every edit. */
  rev: number
  updatedAt: number
  /**
   * Index of the last feature that is built. Features after it stay in the tree
   * but are rolled back. `-1` means nothing is built.
   */
  historyIndex: number
  sketches: CadSketch[]
  features: CadFeature[]
  /** Named numbers shared by the part. */
  params: Record<string, number>
}

const UNITS: readonly LengthUnit[] = ['mm', 'cm', 'm', 'in']

export function emptyDocument(partial: Partial<CadDocument> = {}): CadDocument {
  return {
    id: partial.id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    name: partial.name ?? 'Part',
    units: partial.units ?? 'mm',
    rev: partial.rev ?? 0,
    updatedAt: partial.updatedAt ?? Date.now(),
    historyIndex: partial.historyIndex ?? -1,
    sketches: partial.sketches ?? [],
    features: partial.features ?? [],
    params: partial.params ?? {},
  }
}

/** Alias used by the feature-tree helpers. */
export const emptyCadDocument = emptyDocument

/** A box sitting on the ground plane, stepped along X so the next one does not overlap. */
export function makeBoxFeature(doc: CadDocument, id: string = crypto.randomUUID()): CadFeature {
  const count = doc.features.filter((feature) => feature.kind === 'box').length
  const height = 20
  return {
    id,
    name: `Box ${count + 1}`,
    kind: 'box',
    suppressed: false,
    params: { width: 20, depth: 20, height, x: count * 30, y: height / 2, z: 0 },
  }
}

export function appendFeature(doc: CadDocument, feature: CadFeature): CadDocument {
  const features = [...doc.features, feature]
  return { ...doc, features, rev: doc.rev + 1, historyIndex: features.length - 1 }
}

export function updateFeature(
  doc: CadDocument,
  id: string,
  patch: Partial<Pick<CadFeature, 'name' | 'params' | 'suppressed'>>,
): CadDocument {
  let changed = false
  const features = doc.features.map((feature) => {
    if (feature.id !== id) return feature
    changed = true
    return {
      ...feature,
      ...patch,
      params: patch.params ? { ...feature.params, ...patch.params } : feature.params,
    }
  })
  if (!changed) return doc
  return { ...doc, features, rev: doc.rev + 1 }
}

export function removeFeature(doc: CadDocument, id: string): CadDocument {
  const features = doc.features.filter((feature) => feature.id !== id)
  if (features.length === doc.features.length) return doc
  const historyIndex = features.length === 0 ? -1 : Math.min(doc.historyIndex, features.length - 1)
  return { ...doc, features, rev: doc.rev + 1, historyIndex }
}

/** Swaps a feature with its neighbor. `direction` is `-1` (up) or `1` (down). */
export function moveFeature(doc: CadDocument, id: string, direction: -1 | 1): CadDocument {
  const index = doc.features.findIndex((feature) => feature.id === id)
  const next = index + direction
  if (index < 0 || next < 0 || next >= doc.features.length) return doc
  const features = doc.features.slice()
  const current = features[index]
  const neighbor = features[next]
  if (!current || !neighbor) return doc
  features[index] = neighbor
  features[next] = current
  return { ...doc, features, rev: doc.rev + 1, historyIndex: features.length - 1 }
}

function isUnit(value: string): value is LengthUnit {
  return (UNITS as readonly string[]).includes(value)
}

function isFeature(value: unknown): value is CadFeature {
  if (!value || typeof value !== 'object') return false
  const feature = value as Record<string, unknown>
  return (
    typeof feature.id === 'string' &&
    typeof feature.name === 'string' &&
    typeof feature.kind === 'string' &&
    typeof feature.suppressed === 'boolean' &&
    !!feature.params &&
    typeof feature.params === 'object'
  )
}

/** True when `value` has the document fields this pane reads and writes. */
export function isCadDocument(value: unknown): value is CadDocument {
  if (!value || typeof value !== 'object') return false
  const doc = value as Record<string, unknown>
  return (
    typeof doc.id === 'string' &&
    typeof doc.name === 'string' &&
    typeof doc.units === 'string' &&
    isUnit(doc.units) &&
    typeof doc.rev === 'number' &&
    typeof doc.updatedAt === 'number' &&
    typeof doc.historyIndex === 'number' &&
    Array.isArray(doc.sketches) &&
    Array.isArray(doc.features) &&
    doc.features.every(isFeature) &&
    !!doc.params &&
    typeof doc.params === 'object'
  )
}

export type FeatureNode = CadFeature
export type FeatureDraft = Omit<CadFeature, 'id' | 'name' | 'suppressed'> & {
  id?: string
  name?: string
  suppressed?: boolean
}
export type FeatureParamsOf<_K extends FeatureKind> = Record<string, ParamValue>

