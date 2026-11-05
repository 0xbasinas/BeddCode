import type { Sketch } from '../sketcher/types.ts'
import { solveSketch } from '../sketcher/solve.ts'
import type { CadDocument, FeatureKind, FeatureNode } from './CadDocument.ts'

/** One kernel call, in rebuild order. Suppressed features are not included. */
export interface RebuildOp {
  featureId: string
  name: string
  kind: FeatureKind
  params: FeatureNode['params']
  /** Solved sketch when the feature names one that is on the document. */
  sketch?: Sketch
}

/**
 * Kernel the rebuild applies ops to. Tests pass a mock that records calls.
 * A real kernel (replicad / OCCT) implements the same methods.
 */
export interface RebuildKernel {
  box(op: RebuildOp): void
  cylinder(op: RebuildOp): void
  sphere(op: RebuildOp): void
  extrude(op: RebuildOp): void
  revolve(op: RebuildOp): void
  fillet(op: RebuildOp): void
  chamfer(op: RebuildOp): void
  union(op: RebuildOp): void
  cut(op: RebuildOp): void
  intersect(op: RebuildOp): void
}

/** Features in tree order, skipping suppressed ones. Sketch profiles are solved first. */
export function rebuildPlan(doc: CadDocument): RebuildOp[] {
  const sketches = new Map(doc.sketches.map((sketch) => [sketch.id, solveSketch(sketch)]))
  const ops: RebuildOp[] = []
  for (const feature of doc.features) {
    if (feature.suppressed) continue
    const sketchId = sketchIdOf(feature)
    const sketch = sketchId ? sketches.get(sketchId) : undefined
    ops.push({
      featureId: feature.id,
      name: feature.name,
      kind: feature.kind,
      params: feature.params,
      ...(sketch ? { sketch } : {}),
    })
  }
  return ops
}

/** Applies a plan. The kernel is called once per op, in order. */
export function applyRebuild(plan: readonly RebuildOp[], kernel: RebuildKernel): void {
  for (const op of plan) kernel[op.kind](op)
}

/** Plans `doc` and applies it. */
export function rebuild(doc: CadDocument, kernel: RebuildKernel): RebuildOp[] {
  const plan = rebuildPlan(doc)
  applyRebuild(plan, kernel)
  return plan
}

function sketchIdOf(feature: FeatureNode): string | undefined {
  if (feature.kind === 'extrude' || feature.kind === 'revolve') return feature.params.sketchId
  return undefined
}
