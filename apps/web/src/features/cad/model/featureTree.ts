import type { Sketch } from '../sketcher/types.ts'
import {
  emptyCadDocument,
  type CadDocument,
  type CadFeature,
  type FeatureDraft,
  type FeatureKind,
  type FeatureNode,
  type FeatureParamsOf,
  type ParamValue,
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
  sketch: 'Sketch',
}

/** Appends a feature. It rebuilds after the features already in the tree. */
export function addFeature(doc: CadDocument, draft: FeatureDraft): CadDocument {
  const feature = createFeature(doc, draft)
  return touch(doc, {
    features: [...doc.features, feature],
    historyIndex: doc.features.length,
  })
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
    params: { ...feature.params, ...(patch as Record<string, ParamValue>) },
  }
  return replaceFeature(doc, next)
}

/** `suppressed` defaults to true. A suppressed feature is skipped by rebuild. */
export function suppressFeature(doc: CadDocument, id: string, suppressed = true): CadDocument {
  const feature = requireFeature(doc, id)
  if (feature.suppressed === suppressed) return doc
  return replaceFeature(doc, { ...feature, suppressed })
}

export function deleteFeature(doc: CadDocument, id: string): CadDocument {
  requireFeature(doc, id)
  const features = doc.features.filter((feature) => feature.id !== id)
  const historyIndex = features.length === 0 ? -1 : Math.min(doc.historyIndex, features.length - 1)
  return touch(doc, { features, historyIndex })
}

export function reorderFeature(doc: CadDocument, id: string, toIndex: number): CadDocument {
  const from = indexOf(doc, id)
  if (from < 0) throw new Error(`No feature ${id}`)
  if (toIndex < 0 || toIndex >= doc.features.length) {
    throw new Error(`Reorder index ${toIndex} is outside the tree`)
  }
  if (from === toIndex) return doc
  const features = doc.features.slice()
  const [moved] = features.splice(from, 1)
  if (!moved) return doc
  features.splice(toIndex, 0, moved)
  return touch(doc, { features, historyIndex: features.length - 1 })
}

export function upsertSketch(doc: CadDocument, sketch: Sketch): CadDocument {
  const sketches = doc.sketches.filter((item) => item.id !== sketch.id)
  // Store a thin CadSketch view; full sketcher state lives with the editor.
  sketches.push({
    id: sketch.id,
    name: sketch.id,
    plane: 'XY',
    entities: [],
  })
  return touch(doc, { sketches })
}

export function deleteSketch(doc: CadDocument, id: string): CadDocument {
  return touch(doc, { sketches: doc.sketches.filter((sketch) => sketch.id !== id) })
}

function createFeature(doc: CadDocument, draft: FeatureDraft): CadFeature {
  const kind = draft.kind
  const count = doc.features.filter((feature) => feature.kind === kind).length
  return {
    id: draft.id ?? nextFeatureId(doc),
    name: draft.name ?? `${KIND_LABEL[kind]} ${count + 1}`,
    kind,
    suppressed: draft.suppressed ?? false,
    params: { ...draft.params },
  }
}

function nextFeatureId(doc: CadDocument): string {
  return `feat-${doc.features.length + 1}-${Math.random().toString(36).slice(2, 8)}`
}

function requireFeature(doc: CadDocument, id: string): FeatureNode {
  const feature = doc.features.find((item) => item.id === id)
  if (!feature) throw new Error(`No feature ${id}`)
  return feature
}

function indexOf(doc: CadDocument, id: string): number {
  return doc.features.findIndex((feature) => feature.id === id)
}

function replaceFeature(doc: CadDocument, next: FeatureNode): CadDocument {
  const features = doc.features.map((feature) => (feature.id === next.id ? next : feature))
  return touch(doc, { features })
}

function touch(doc: CadDocument, patch: Partial<CadDocument>): CadDocument {
  return { ...doc, ...patch, rev: doc.rev + 1, updatedAt: Date.now() }
}

export function newPart(name?: string): CadDocument {
  return emptyCadDocument(name ? { name } : {})
}
