/** A CAD part stored as JSON. Edits return a new document and bump `rev`. */

import { holeAxisFromFacePoint } from '../kernel/featureOps.ts'
import type { SketchEntity } from '../sketcher/types.ts'

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in'

export type FeatureKind =
  | 'box'
  | 'cylinder'
  | 'sphere'
  | 'extrude'
  | 'revolve'
  | 'fillet'
  | 'chamfer'
  | 'hole'
  | 'union'
  | 'cut'
  | 'intersect'
  | 'sketch'
  | 'import'

export type ParamValue = number | string | boolean

export type { SketchEntity }

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

function countKind(doc: CadDocument, kind: FeatureKind): number {
  return doc.features.filter((feature) => feature.kind === kind).length
}

/** A box sitting on the ground plane, stepped along X so the next one does not overlap. */
export function makeBoxFeature(doc: CadDocument, id: string = crypto.randomUUID()): CadFeature {
  const count = countKind(doc, 'box')
  const height = 20
  return {
    id,
    name: `Box ${count + 1}`,
    kind: 'box',
    suppressed: false,
    params: { width: 20, depth: 20, height, x: count * 30, y: height / 2, z: 0 },
  }
}

/** A cylinder standing on the ground plane, stepped along X. */
export function makeCylinderFeature(
  doc: CadDocument,
  id: string = crypto.randomUUID(),
): CadFeature {
  const count = countKind(doc, 'cylinder')
  const height = 20
  return {
    id,
    name: `Cylinder ${count + 1}`,
    kind: 'cylinder',
    suppressed: false,
    params: { radius: 10, height, x: count * 30, y: height / 2, z: 0 },
  }
}

/** A sphere sitting on the ground plane, stepped along X. */
export function makeSphereFeature(doc: CadDocument, id: string = crypto.randomUUID()): CadFeature {
  const count = countKind(doc, 'sphere')
  const radius = 10
  return {
    id,
    name: `Sphere ${count + 1}`,
    kind: 'sphere',
    suppressed: false,
    params: { radius, x: count * 30, y: radius, z: 0 },
  }
}

export function makeSketchFeature(
  doc: CadDocument,
  plane: CadSketch['plane'] = 'XY',
  id: string = crypto.randomUUID(),
): CadFeature {
  const count = countKind(doc, 'sketch')
  return {
    id,
    name: `Sketch ${count + 1}`,
    kind: 'sketch',
    suppressed: false,
    sketchId: id,
    params: { plane },
  }
}

/** Adds an empty sketch feature and its sketch record in one revision. */
export function appendSketch(
  doc: CadDocument,
  plane: CadSketch['plane'] = 'XY',
  id?: string,
): { doc: CadDocument; feature: CadFeature } {
  const feature = id ? makeSketchFeature(doc, plane, id) : makeSketchFeature(doc, plane)
  const sketch: CadSketch = { id: feature.id, name: feature.name, plane, entities: [] }
  const features = [...doc.features, feature]
  return {
    feature,
    doc: {
      ...doc,
      features,
      sketches: [...doc.sketches.filter((item) => item.id !== sketch.id), sketch],
      rev: doc.rev + 1,
      historyIndex: features.length - 1,
    },
  }
}

export function makeExtrudeFeature(
  doc: CadDocument,
  sketchId: string,
  id: string = crypto.randomUUID(),
): CadFeature {
  const count = countKind(doc, 'extrude')
  return {
    id,
    name: `Extrude ${count + 1}`,
    kind: 'extrude',
    suppressed: false,
    sketchId,
    params: { sketchId, distance: 10, bothSides: false, cut: false },
  }
}

export function makeRevolveFeature(
  doc: CadDocument,
  sketchId: string,
  id: string = crypto.randomUUID(),
): CadFeature {
  const count = countKind(doc, 'revolve')
  return {
    id,
    name: `Revolve ${count + 1}`,
    kind: 'revolve',
    suppressed: false,
    sketchId,
    params: { sketchId, angle: 360, axis: 'Z' },
  }
}

export function makeFilletFeature(
  doc: CadDocument,
  targetId: string,
  edgeIds?: string,
  id: string = crypto.randomUUID(),
  edgeRefs?: string,
  radius = 4,
): CadFeature {
  const count = countKind(doc, 'fillet')
  return {
    id,
    name: `Fillet ${count + 1}`,
    kind: 'fillet',
    suppressed: false,
    params: {
      targetId,
      radius,
      ...(edgeIds ? { edgeIds } : {}),
      ...(edgeRefs ? { edgeRefs } : {}),
    },
  }
}

export function makeChamferFeature(
  doc: CadDocument,
  targetId: string,
  edgeIds?: string,
  id: string = crypto.randomUUID(),
  edgeRefs?: string,
  radius = 4,
): CadFeature {
  const count = countKind(doc, 'chamfer')
  return {
    id,
    name: `Chamfer ${count + 1}`,
    kind: 'chamfer',
    suppressed: false,
    params: {
      targetId,
      radius,
      ...(edgeIds ? { edgeIds } : {}),
      ...(edgeRefs ? { edgeRefs } : {}),
    },
  }
}

export interface HoleParams {
  /** Body the hole cuts. */
  target: string
  diameter?: number
  depth?: number
  /** Defaults to true. A blind hole uses `depth`. */
  throughAll?: boolean
  /** Face point in millimetres. `facePoint` wins when both are set. */
  x?: number
  y?: number
  z?: number
  facePoint?: [number, number, number]
  cboreDiameter?: number
  cboreDepth?: number
  direction?: string
  id?: string
}

/** @deprecated Prefer HoleParams; kept for callers that imported AddHoleParams. */
export type AddHoleParams = HoleParams

function holeNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Builds a hole feature. Defaults: diameter 8, through-all, depth 10.
 * The kernel maps this to a first-class hole op.
 */
export function makeHoleFeature(
  doc: CadDocument,
  params: HoleParams,
  id: string = crypto.randomUUID(),
): CadFeature {
  const count = countKind(doc, 'hole')
  const point = params.facePoint ?? [
    holeNumber(params.x, 0),
    holeNumber(params.y, 0),
    holeNumber(params.z, 0),
  ]
  const throughAll = params.throughAll !== false
  return {
    id: params.id ?? id,
    name: `Hole ${count + 1}`,
    kind: 'hole',
    suppressed: false,
    params: {
      target: params.target,
      targetId: params.target,
      diameter: holeNumber(params.diameter, 8),
      ...(throughAll
        ? { throughAll: true }
        : { throughAll: false, depth: holeNumber(params.depth, 10) }),
      ...(throughAll && params.depth !== undefined ? { depth: params.depth } : {}),
      x: point[0],
      y: point[1],
      z: point[2],
      ...(holeNumber(params.cboreDiameter, 0) > 0 && holeNumber(params.cboreDepth, 0) > 0
        ? {
            cboreDiameter: holeNumber(params.cboreDiameter, 0),
            cboreDepth: holeNumber(params.cboreDepth, 0),
          }
        : {}),
      ...(params.direction ? { direction: params.direction } : {}),
    },
  }
}

/** Appends a hole and returns the new document plus the feature just added. */
export function addHole(
  doc: CadDocument,
  params: HoleParams,
  id?: string,
): { doc: CadDocument; feature: CadFeature } {
  const feature = makeHoleFeature(doc, params, id ?? params.id ?? crypto.randomUUID())
  return { feature, doc: appendFeature(doc, feature) }
}

export interface HoleFacePick {
  /** Feature that owns the picked face. This is the body the hole cuts. */
  targetId: string
  point: [number, number, number]
  /** Outward normal of that face. */
  normal: [number, number, number]
  /** A point on the face plane, when the click is not already on it. */
  planeOrigin?: [number, number, number]
  diameter?: number
  throughAll?: boolean
  depth?: number
  id?: string
}

/**
 * The picked face's feature. A click on the plate stays on the plate.
 * It does not retarget a later body such as a boss.
 */
export function holeTargetId(features: readonly { id: string }[], pickedId: string): string {
  const owner = features.find((feature) => feature.id === pickedId)
  if (!owner) throw new Error('hole needs the feature that owns the face')
  return owner.id
}

/**
 * Places a hole from a face click. The center is the click projected onto
 * the face. The axis points into the solid. Diameter defaults to 8 and the
 * hole goes through unless `throughAll` is false.
 */
export function addHoleFromFace(
  doc: CadDocument,
  pick: HoleFacePick,
): { doc: CadDocument; feature: CadFeature } {
  const target = holeTargetId(doc.features, pick.targetId)
  const axis = holeAxisFromFacePoint({
    point: pick.point,
    normal: pick.normal,
    planeOrigin: pick.planeOrigin,
  })
  return addHole(doc, {
    id: pick.id,
    target,
    facePoint: axis.origin,
    direction: axis.direction,
    diameter: pick.diameter,
    throughAll: pick.throughAll,
    depth: pick.depth,
  })
}

export function makeBooleanFeature(
  doc: CadDocument,
  kind: 'union' | 'cut' | 'intersect',
  targetId: string,
  toolId: string,
  id: string = crypto.randomUUID(),
): CadFeature {
  const count = countKind(doc, kind)
  const label = kind === 'union' ? 'Union' : kind === 'cut' ? 'Cut' : 'Intersect'
  return {
    id,
    name: `${label} ${count + 1}`,
    kind,
    suppressed: false,
    params: { targetId, toolId },
  }
}

export function makeImportFeature(
  doc: CadDocument,
  fileName: string,
  id: string = crypto.randomUUID(),
): CadFeature {
  const count = countKind(doc, 'import')
  const label = fileName.replace(/\.(step|stp)$/i, '') || `Import ${count + 1}`
  return {
    id,
    name: label,
    kind: 'import',
    suppressed: false,
    params: { fileName },
  }
}

export function isSolidFeature(feature: CadFeature): boolean {
  return feature.kind !== 'sketch'
}

export function setSketchEntities(
  doc: CadDocument,
  sketchId: string,
  entities: SketchEntity[],
): CadDocument {
  let changed = false
  const sketches = doc.sketches.map((sketch) => {
    if (sketch.id !== sketchId) return sketch
    changed = true
    return { ...sketch, entities }
  })
  if (!changed) return doc
  return { ...doc, sketches, rev: doc.rev + 1, updatedAt: Date.now() }
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
