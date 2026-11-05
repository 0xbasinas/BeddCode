import type { Sketch } from '../sketcher/types.ts'
import { solveSketch } from '../sketcher/solve.ts'
import {
  emptyCadDocument,
  type CadDocument,
  type FeatureDraft,
  type FeatureKind,
  type FeatureNode,
  type FeatureParamsOf,
} from './CadDocument.ts'

const KIND_LABEL: Record<FeatureKind, string> = {
  box: 'Box',
  cylinder: 'Cylinder',
  sphere: 'Sphere',
  extrude: 'Extrude',
  revolve: 'Revolve',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  union: 'Union',
  cut: 'Cut',
  intersect: 'Intersect',
}

/** Appends a feature. It rebuilds after the features already in the tree. */
export function addFeature(doc: CadDocument, draft: FeatureDraft): CadDocument {
  const feature = createFeature(doc, draft)
  return touch(doc, { features: [...doc.features, feature] })
}

/** Merges `patch` into the feature's params. The kind stays the same. */
export function editFeatureParams<K extends FeatureKind>(
  doc: CadDocument,
  id: string,
  patch: Partial<FeatureParamsOf<K>>,
): CadDocument {
  const feature = requireFeature(doc, id)
  const next: FeatureNode = {
    ...feature,
    params: { ...feature.params, ...patch },
  } as FeatureNode
  return replaceFeature(doc, next)
}

/** `suppressed` defaults to true. A suppressed feature is skipped by rebuild. */
export function suppressFeature(doc: CadDocument, id: string, suppressed = true): CadDocument {
  const feature = requireFeature(doc, id)
  if (feature.suppressed === suppressed) return doc
  return replaceFeature(doc, { ...feature, suppressed } as FeatureNode)
}

/** Removes the feature. Later features that still name it are left in place. */
export function deleteFeature(doc: CadDocument, id: string): CadDocument {
  requireFeature(doc, id)
  return touch(doc, { features: doc.features.filter((feature) => feature.id !== id) })
}

/**
 * Moves `id` so it sits at `toIndex` after the move. 0 is the first feature rebuilt.
 * `toIndex` is the index in the list after the feature has been taken out and put back.
 */
export function reorderFeature(doc: CadDocument, id: string, toIndex: number): CadDocument {
  const from = indexOf(doc, id)
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= doc.features.length) {
    throw new Error(`Feature index ${toIndex} is outside 0..${doc.features.length - 1}`)
  }
  if (from === toIndex) return doc
  const features = doc.features.filter((feature) => feature.id !== id)
  const moved = doc.features[from]
  if (!moved) throw new Error(`No feature ${id}`)
  features.splice(toIndex, 0, moved)
  return touch(doc, { features })
}

/** Inserts or replaces a sketch, solved, so rebuild sees the evaluated profile. */
export function upsertSketch(doc: CadDocument, sketch: Sketch): CadDocument {
  const solved = solveSketch(sketch)
  const sketches = doc.sketches.some((item) => item.id === solved.id)
    ? doc.sketches.map((item) => (item.id === solved.id ? solved : item))
    : [...doc.sketches, solved]
  return touch(doc, { sketches })
}

export function deleteSketch(doc: CadDocument, id: string): CadDocument {
  if (!doc.sketches.some((sketch) => sketch.id === id)) throw new Error(`No sketch ${id}`)
  return touch(doc, { sketches: doc.sketches.filter((sketch) => sketch.id !== id) })
}

function createFeature(doc: CadDocument, draft: FeatureDraft): FeatureNode {
  const id = draft.id ?? nextFeatureId(doc)
  if (doc.features.some((feature) => feature.id === id))
    throw new Error(`Feature ${id} already exists`)
  const sameKind = doc.features.filter((feature) => feature.kind === draft.kind).length
  return {
    id,
    name: draft.name ?? `${KIND_LABEL[draft.kind]} ${sameKind + 1}`,
    kind: draft.kind,
    suppressed: draft.suppressed ?? false,
    params: { ...draft.params },
  } as FeatureNode
}

function nextFeatureId(doc: CadDocument): string {
  const used = new Set(doc.features.map((feature) => feature.id))
  let n = doc.features.length + 1
  while (used.has(`f${n}`)) n += 1
  return `f${n}`
}

function requireFeature(doc: CadDocument, id: string): FeatureNode {
  const feature = doc.features.find((item) => item.id === id)
  if (!feature) throw new Error(`No feature ${id}`)
  return feature
}

function indexOf(doc: CadDocument, id: string): number {
  const index = doc.features.findIndex((feature) => feature.id === id)
  if (index < 0) throw new Error(`No feature ${id}`)
  return index
}

function replaceFeature(doc: CadDocument, next: FeatureNode): CadDocument {
  return touch(doc, {
    features: doc.features.map((feature) => (feature.id === next.id ? next : feature)),
  })
}

function touch(doc: CadDocument, patch: Partial<CadDocument>): CadDocument {
  return { ...doc, ...patch, rev: doc.rev + 1, updatedAt: doc.updatedAt + 1 }
}

/** A part with no features, used by tests and a new pane. */
export function newPart(name?: string): CadDocument {
  return emptyCadDocument(name ? { name } : {})
}
